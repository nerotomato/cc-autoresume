import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PauseTrigger } from './state-machine';
import { formatLocalTimeSmart } from './side-banner';

export interface StatusLineSpySetup {
  spyScriptPath: string;
  settingsOverride: string;
  rateLimitsFilePath: string;
  statusLineHintFilePath: string;
  originalStatusLineCommand?: string;
  cleanup(): Promise<void>;
}

export interface CreateStatusLineSpyOptions {
  stateDir: string;
  pid?: number;
  settingsPath?: string;
}

export async function createStatusLineSpy(options: CreateStatusLineSpyOptions): Promise<StatusLineSpySetup> {
  const pid = options.pid ?? process.pid;
  const stateDir = options.stateDir;
  await fs.mkdir(stateDir, { recursive: true });

  const spyScriptPath = path.join(stateDir, `spy-${pid}.js`);
  const rateLimitsFilePath = path.join(stateDir, `rate-limits-${pid}.json`);
  const statusLineHintFilePath = path.join(stateDir, `statusline-hint-${pid}.txt`);
  const settingsPath = options.settingsPath ?? path.join(os.homedir(), '.claude', 'settings.json');
  const existing = await readStatusLineSettings(settingsPath);

  await fs.writeFile(spyScriptPath, buildSpyScript(), { encoding: 'utf8' });
  if (process.platform !== 'win32') await fs.chmod(spyScriptPath, 0o755);

  const isWin = process.platform === 'win32';
  const statusLine: Record<string, unknown> = {
    type: 'command',
    command: isWin
      ? `node ${shellQuoteWin(spyScriptPath)}`
      : `node ${shellQuote(spyScriptPath)}`,
  };
  if (existing.refreshInterval !== undefined) statusLine.refreshInterval = existing.refreshInterval;

  return {
    spyScriptPath,
    settingsOverride: JSON.stringify({ statusLine }),
    rateLimitsFilePath,
    statusLineHintFilePath,
    originalStatusLineCommand: existing.command,
    cleanup: async () => {
      await Promise.all([
        unlinkIfExists(spyScriptPath),
        unlinkIfExists(rateLimitsFilePath),
        unlinkIfExists(statusLineHintFilePath),
      ]);
    },
  };
}

export async function writeStatusLineHint(filePath: string, wakeAt: string, trigger: PauseTrigger): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const label = trigger === 'screen' ? '已达额度上限' : '接近额度上限';
  await fs.writeFile(filePath, `cc-autoresume: ${label}，${formatLocalTimeSmart(wakeAt)} 自动恢复`, 'utf8');
}

export async function clearStatusLineHint(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  await unlinkIfExists(filePath);
}

export async function sweepStaleStatusLineFiles(
  dir: string,
  processAlive: (pid: number | undefined) => boolean,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (isNotFound(error)) return [];
    return [];
  }

  const swept: string[] = [];
  for (const name of entries) {
    const pid = extractRuntimeFilePid(name);
    if (pid === undefined || processAlive(pid)) continue;
    const filePath = path.join(dir, name);
    try {
      await fs.unlink(filePath);
      swept.push(filePath);
    } catch {
    }
  }
  return swept;
}

async function readStatusLineSettings(settingsPath: string): Promise<{ command?: string; refreshInterval?: number }> {
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const statusLine = (parsed as Record<string, unknown>).statusLine;
    if (typeof statusLine !== 'object' || statusLine === null || Array.isArray(statusLine)) return {};
    const record = statusLine as Record<string, unknown>;
    return {
      command: typeof record.command === 'string' && record.command.length > 0 ? record.command : undefined,
      refreshInterval: typeof record.refreshInterval === 'number' && Number.isFinite(record.refreshInterval)
        ? record.refreshInterval
        : undefined,
    };
  } catch (error) {
    if (isNotFound(error)) return {};
    return {};
  }
}

function buildSpyScript(): string {
  const isWin = process.platform === 'win32';
  const shell = isWin ? `'cmd.exe', ['/c', cmd]` : `'sh', ['-c', cmd]`;
  return `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks).toString('utf8');
  const rateFile = process.env.CC_AUTORESUME_RATE_LIMITS_FILE;
  if (rateFile) try { fs.writeFileSync(rateFile, input, 'utf8'); } catch {}
  let original = '';
  const cmd = process.env.CC_AUTORESUME_ORIGINAL_STATUSLINE;
  if (cmd) {
    try {
      const r = spawnSync(${shell}, { input, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] });
      if (r.stdout) original = r.stdout.replace(/\\n$/, '');
    } catch {}
  }
  let hint = '';
  const hintFile = process.env.CC_AUTORESUME_STATUSLINE_HINT_FILE;
  if (hintFile) try { hint = fs.readFileSync(hintFile, 'utf8').trim(); } catch {}
  const parts = [original, hint].filter(Boolean);
  if (parts.length > 0) process.stdout.write(parts.join(' | ') + '\\n');
});
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellQuoteWin(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function extractRuntimeFilePid(name: string): number | undefined {
  const match = /^(?:spy|rate-limits|statusline-hint)-(\d+)\.(?:js|json|txt)$/.exec(name);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}
