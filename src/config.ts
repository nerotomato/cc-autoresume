import os from 'node:os';
import path from 'node:path';

export type TargetName = 'auto' | 'claude' | 'codex';
export type AdapterPreference = 'auto' | 'mock' | 'anthropic';

export interface Config {
  target: TargetName;
  targetArgs: string[];
  threshold: number;
  maxWaitHours: number;
  balanceWarn: number;
  logPath: string;
  statePath: string;
  resumeHint: string;
  adapter: AdapterPreference;
  testMode: boolean;
  wakeBufferMs: number;
  targetCommandOverride?: string;
}

const targetNames = new Set<TargetName>(['auto', 'claude', 'codex']);
const adapterPreferences = new Set<AdapterPreference>(['auto', 'mock', 'anthropic']);

export function parseConfig(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = parseArgs(argv);
  const target = parseTarget(parsed.target ?? env.CC_AUTORESUME_TARGET ?? 'auto');
  const testMode = env.CC_AUTORESUME_TEST_MODE === '1' || env.CC_AUTORESUME_TEST_MODE === 'true';

  return {
    target,
    targetArgs: parsed.targetArgs,
    threshold: parseBoundedNumber(env.CC_AUTORESUME_THRESHOLD, 99, 0, 100, 'CC_AUTORESUME_THRESHOLD'),
    maxWaitHours: parseBoundedNumber(env.CC_AUTORESUME_MAX_WAIT_HOURS, 12, Number.MIN_VALUE, Number.POSITIVE_INFINITY, 'CC_AUTORESUME_MAX_WAIT_HOURS'),
    balanceWarn: parseBoundedNumber(env.CC_AUTORESUME_BALANCE_WARN, 5, 0, Number.POSITIVE_INFINITY, 'CC_AUTORESUME_BALANCE_WARN'),
    logPath: expandHome(env.CC_AUTORESUME_LOG ?? '~/.cc-autoresume/log.jsonl'),
    statePath: expandHome(env.CC_AUTORESUME_STATE_PATH ?? '~/.cc-autoresume/state.json'),
    resumeHint: env.CC_AUTORESUME_RESUME_HINT ?? '继续',
    adapter: parseAdapterPreference(env.CC_AUTORESUME_ADAPTER ?? 'auto'),
    testMode,
    wakeBufferMs: testMode
      ? parseBoundedNumber(env.CC_AUTORESUME_WAKE_BUFFER_MS, 30_000, 0, Number.POSITIVE_INFINITY, 'CC_AUTORESUME_WAKE_BUFFER_MS')
      : 30_000,
    targetCommandOverride: testMode ? env.CC_AUTORESUME_TARGET_COMMAND : undefined,
  };
}

export function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseArgs(argv: string[]): { target?: string; targetArgs: string[] } {
  const separatorIndex = argv.indexOf('--');
  const optionArgs = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  const targetArgs = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1);
  let target: string | undefined;

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length);
      continue;
    }
    if (arg === '--target') {
      const value = optionArgs[index + 1];
      if (!value) throw new Error('--target 需要一个值');
      target = value;
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }

  return { target, targetArgs };
}

function parseTarget(value: string): TargetName {
  if (targetNames.has(value as TargetName)) return value as TargetName;
  throw new Error(`不支持的 target：${value}`);
}

function parseAdapterPreference(value: string): AdapterPreference {
  if (adapterPreferences.has(value as AdapterPreference)) return value as AdapterPreference;
  throw new Error(`不支持的 adapter：${value}`);
}

function parseBoundedNumber(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的数字`);
  }
  return parsed;
}
