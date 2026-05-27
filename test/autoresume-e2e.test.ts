import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-autoresume-e2e-'));
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, { encoding: 'utf8' });
  if (process.platform !== 'win32') await fs.chmod(filePath, 0o700);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await fn();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await wait(50);
  }
  if (lastError) throw lastError;
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

async function readLogEvents(logPath: string): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await fs.readFile(logPath, 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') return [];
    throw error;
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });
}

describe('自动化模拟撞墙端到端', () => {
  it('自动写入 fake rate_limits 后暂停、追加 statusLine 提示、到点恢复并清理', async () => {
    const repoRoot = process.cwd();
    const tmpHome = await tempDir();
    const ccDir = path.join(tmpHome, '.cc-autoresume');
    const claudeDir = path.join(tmpHome, '.claude');
    await fs.mkdir(ccDir, { recursive: true });
    await fs.mkdir(claudeDir, { recursive: true });

    const stdinLog = path.join(tmpHome, 'fake-target-stdin.log');
    const fakeTarget = path.join(tmpHome, 'fake-target.js');
    await writeExecutable(fakeTarget, `#!/usr/bin/env node
const fs = require('fs');
const log = process.env.FAKE_TARGET_STDIN_LOG;
process.stdin.resume();
process.stdin.on('data', (chunk) => fs.appendFileSync(log, chunk.toString('utf8')));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`);

    const originalStatusLine = path.join(tmpHome, 'original-statusline.js');
    await writeExecutable(originalStatusLine, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => process.stdout.write('original-status'));
`);
    await fs.writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify({
      statusLine: { command: `node ${originalStatusLine}`, refreshInterval: 1 },
    }), 'utf8');

    const logPath = path.join(ccDir, 'log.jsonl');
    const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const stderr: string[] = [];
    const stdout: string[] = [];
    const child = spawn(process.execPath, [tsxCli, 'src/index.ts', '--target=claude'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: tmpHome,
        ANTHROPIC_BASE_URL: '',
        CC_AUTORESUME_TEST_MODE: '1',
        CC_AUTORESUME_TARGET_COMMAND: fakeTarget,
        CC_AUTORESUME_DISABLE_SESSION_TRACKING: '1',
        CC_AUTORESUME_RATE_LIMITS_POLL_MS: '50',
        CC_AUTORESUME_WAKE_BUFFER_MS: '0',
        CC_AUTORESUME_LOG: logPath,
        CC_AUTORESUME_STATE_DIR: ccDir,
        FAKE_TARGET_STDIN_LOG: stdinLog,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => stdout.push(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));

    try {
      const wrapperStart = await waitFor(async () => {
        const events = await readLogEvents(logPath);
        return events.find((event) => event.event === 'wrapper_start' && event.statusLineSpy === true);
      }, 5000);
      const spyPath = String(wrapperStart.spyScriptPath);
      const rateFile = String(wrapperStart.rateLimitsFilePath);
      const hintFile = String(wrapperStart.statusLineHintFilePath);
      await fs.stat(spyPath);

      const resetAt = new Date(Date.now() + 800).toISOString();
      await fs.writeFile(rateFile, JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: 100, resets_at: resetAt },
          seven_day: { used_percentage: 10, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
        },
      }), 'utf8');

      await waitFor(async () => {
        const events = await readLogEvents(logPath);
        return events.some((event) => event.event === 'statusline_pause_due') ? true : undefined;
      }, 5000);
      const hint = await waitFor(async () => {
        const value = await fs.readFile(hintFile, 'utf8');
        return value.includes('cc-autoresume') ? value : undefined;
      }, 2000);
      expect(hint).toContain('自动恢复');

      const beforeWake = spawnSync('node', [spyPath], {
        input: '{}',
        encoding: 'utf8',
        env: {
          ...process.env,
          CC_AUTORESUME_ORIGINAL_STATUSLINE: `node ${originalStatusLine}`,
          CC_AUTORESUME_RATE_LIMITS_FILE: rateFile,
          CC_AUTORESUME_STATUSLINE_HINT_FILE: hintFile,
        },
      });
      expect(beforeWake.status).toBe(0);
      expect(beforeWake.stdout).toContain('original-status | cc-autoresume: 接近额度上限');

      await waitFor(async () => {
        const events = await readLogEvents(logPath);
        return events.some((event) => event.event === 'wake_sent') ? true : undefined;
      }, 5000);
      const stdinText = await waitFor(async () => {
        const value = await fs.readFile(stdinLog, 'utf8');
        return value.includes('继续') ? value : undefined;
      }, 2000);
      expect(stdinText).toContain('继续');

      await waitFor(async () => {
        try {
          await fs.stat(hintFile);
          return undefined;
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') return true;
          throw error;
        }
      }, 2000);
      const afterWake = spawnSync('node', [spyPath], {
        input: '{}',
        encoding: 'utf8',
        env: {
          ...process.env,
          CC_AUTORESUME_ORIGINAL_STATUSLINE: `node ${originalStatusLine}`,
          CC_AUTORESUME_RATE_LIMITS_FILE: rateFile,
          CC_AUTORESUME_STATUSLINE_HINT_FILE: hintFile,
        },
      });
      expect(afterWake.stdout).toBe('original-status\n');

      child.kill('SIGTERM');
      await waitForExit(child);
      await waitFor(async () => {
        try {
          await fs.stat(spyPath);
          return undefined;
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') return true;
          throw error;
        }
      }, 3000);
      await expect(fs.stat(rateFile)).rejects.toMatchObject({ code: 'ENOENT' });
    } catch (error) {
      child.kill('SIGTERM');
      await waitForExit(child);
      const detail = `stdout:\n${stdout.join('')}\nstderr:\n${stderr.join('')}`;
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`);
    }
  }, 15_000);

  it('Claude 官方限额菜单默认自动发送 Enter', async () => {
    const repoRoot = process.cwd();
    const tmpHome = await tempDir();
    const ccDir = path.join(tmpHome, '.cc-autoresume');
    const claudeDir = path.join(tmpHome, '.claude');
    await fs.mkdir(ccDir, { recursive: true });
    await fs.mkdir(claudeDir, { recursive: true });

    const stdinLog = path.join(tmpHome, 'fake-target-stdin.log');
    const fakeTarget = path.join(tmpHome, 'fake-target-menu.js');
    await writeExecutable(fakeTarget, `#!/usr/bin/env node
const fs = require('fs');
const log = process.env.FAKE_TARGET_STDIN_LOG;
process.stdin.resume();
process.stdin.on('data', (chunk) => fs.appendFileSync(log, chunk.toString('utf8')));
setTimeout(() => {
  process.stdout.write("You've hit your session limit · resets 3:10pm (Asia/Shanghai)\\n");
  process.stdout.write("What do you want to do?\\n");
  process.stdout.write("❯ 1. Stop and wait for limit to reset\\n");
  process.stdout.write("  2. Upgrade your plan\\n");
  process.stdout.write("try again in 10 minutes\\n");
}, 100);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`);

    const logPath = path.join(ccDir, 'log.jsonl');
    const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const stderr: string[] = [];
    const stdout: string[] = [];
    const child = spawn(process.execPath, [tsxCli, 'src/index.ts', '--target=claude'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: tmpHome,
        ANTHROPIC_BASE_URL: 'https://example.invalid',
        CC_AUTORESUME_TEST_MODE: '1',
        CC_AUTORESUME_TARGET_COMMAND: fakeTarget,
        CC_AUTORESUME_DISABLE_SESSION_TRACKING: '1',
        CC_AUTORESUME_LOG: logPath,
        CC_AUTORESUME_STATE_DIR: ccDir,
        FAKE_TARGET_STDIN_LOG: stdinLog,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => stdout.push(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));

    try {
      await waitFor(async () => {
        const events = await readLogEvents(logPath);
        return events.some((event) => event.event === 'screen_pause_due') ? true : undefined;
      }, 5000);
      await waitFor(async () => {
        const events = await readLogEvents(logPath);
        return events.some((event) => event.event === 'menu_keys_sent' && event.keys === 'enter') ? true : undefined;
      }, 3000);
      const stdinText = await waitFor(async () => {
        const value = await fs.readFile(stdinLog, 'utf8');
        return value.length > 0 ? value : undefined;
      }, 2000);
      expect(stdinText).toMatch(/[\r\n]/);

      child.kill('SIGTERM');
      await waitForExit(child);
    } catch (error) {
      child.kill('SIGTERM');
      await waitForExit(child);
      const detail = `stdout:\n${stdout.join('')}\nstderr:\n${stderr.join('')}`;
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`);
    }
  }, 15_000);
});
