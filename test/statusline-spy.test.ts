import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearStatusLineHint, createStatusLineSpy, sweepStaleStatusLineFiles, writeStatusLineHint } from '../src/statusline-spy';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-autoresume-spy-test-'));
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, { encoding: 'utf8' });
  if (process.platform !== 'win32') await fs.chmod(filePath, 0o700);
}

describe('statusline-spy', () => {
  it('生成 spy 脚本、保留原 statusLine 并追加 hint', async () => {
    const dir = await tempDir();
    const originalScript = path.join(dir, 'original.js');
    await writeExecutable(originalScript, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => process.stdout.write('original-status'));
`);
    const settingsPath = path.join(dir, 'settings.json');
    await fs.writeFile(settingsPath, JSON.stringify({ statusLine: { command: `node ${originalScript}`, refreshInterval: 7 } }), 'utf8');

    const setup = await createStatusLineSpy({ stateDir: dir, settingsPath, pid: 123 });
    const settingsOverride = JSON.parse(setup.settingsOverride) as { statusLine: { command: string; refreshInterval: number } };
    expect(settingsOverride.statusLine.command).toContain('spy-123.js');
    expect(settingsOverride.statusLine.refreshInterval).toBe(7);
    expect(setup.originalStatusLineCommand).toBe(`node ${originalScript}`);

    const wakeAt = new Date(2026, 4, 20, 14, 3, 0).toISOString();
    await writeStatusLineHint(setup.statusLineHintFilePath, wakeAt, '5h');

    const input = '{"rate_limits":{"five_hour":{"used_percentage":1}}}';
    const result = spawnSync('node', [setup.spyScriptPath], {
      input,
      encoding: 'utf8',
      env: {
        ...process.env,
        CC_AUTORESUME_ORIGINAL_STATUSLINE: setup.originalStatusLineCommand ?? '',
        CC_AUTORESUME_RATE_LIMITS_FILE: setup.rateLimitsFilePath,
        CC_AUTORESUME_STATUSLINE_HINT_FILE: setup.statusLineHintFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('original-status | cc-autoresume: 接近额度上限，');
    expect(result.stdout).toContain('自动恢复');
    await expect(fs.readFile(setup.rateLimitsFilePath, 'utf8')).resolves.toBe(input);

    await clearStatusLineHint(setup.statusLineHintFilePath);
    const withoutHint = spawnSync('node', [setup.spyScriptPath], {
      input,
      encoding: 'utf8',
      env: {
        ...process.env,
        CC_AUTORESUME_ORIGINAL_STATUSLINE: setup.originalStatusLineCommand ?? '',
        CC_AUTORESUME_RATE_LIMITS_FILE: setup.rateLimitsFilePath,
        CC_AUTORESUME_STATUSLINE_HINT_FILE: setup.statusLineHintFilePath,
      },
    });
    expect(withoutHint.stdout).toBe('original-status\n');

    await setup.cleanup();
    await expect(fs.stat(setup.spyScriptPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(setup.rateLimitsFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('没有原 statusLine 时只在有 hint 时输出提示', async () => {
    const dir = await tempDir();
    const setup = await createStatusLineSpy({ stateDir: dir, settingsPath: path.join(dir, 'missing.json'), pid: 456 });

    await writeStatusLineHint(setup.statusLineHintFilePath, new Date(2026, 4, 20, 14, 3, 0).toISOString(), 'screen');
    const result = spawnSync('node', [setup.spyScriptPath], {
      input: '{}',
      encoding: 'utf8',
      env: {
        ...process.env,
        CC_AUTORESUME_ORIGINAL_STATUSLINE: '',
        CC_AUTORESUME_RATE_LIMITS_FILE: setup.rateLimitsFilePath,
        CC_AUTORESUME_STATUSLINE_HINT_FILE: setup.statusLineHintFilePath,
      },
    });

    expect(result.stdout).toContain('cc-autoresume: 已达额度上限，');
    expect(result.stdout).toContain('自动恢复');
    await setup.cleanup();
  });

  it('清理 PID 已死的 spy/rate-limits/hint 临时文件', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'spy-100.js'), '', 'utf8');
    await fs.writeFile(path.join(dir, 'rate-limits-100.json'), '{}', 'utf8');
    await fs.writeFile(path.join(dir, 'statusline-hint-200.txt'), 'hint', 'utf8');
    await fs.writeFile(path.join(dir, 'spy-300.js'), '', 'utf8');

    const swept = await sweepStaleStatusLineFiles(dir, (pid) => pid === 300);

    expect(swept.map((filePath) => path.basename(filePath)).sort()).toEqual([
      'rate-limits-100.json',
      'spy-100.js',
      'statusline-hint-200.txt',
    ]);
    await expect(fs.stat(path.join(dir, 'spy-300.js'))).resolves.toBeDefined();
  });
});
