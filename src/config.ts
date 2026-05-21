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
  defaultWaitHours: number;
  disableScreenScan: boolean;
  disableApiPoll: boolean;
  triggersFile: string;
  restoreMaxAgeHours: number;
  stateDir: string;             // 扫描 state-*.json 用的目录
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
    statePath: expandHome(env.CC_AUTORESUME_STATE_PATH ?? `~/.cc-autoresume/state-${process.pid}.json`),
    stateDir: expandHome('~/.cc-autoresume'),
    resumeHint: env.CC_AUTORESUME_RESUME_HINT ?? '继续',
    adapter: parseAdapterPreference(env.CC_AUTORESUME_ADAPTER ?? 'auto'),
    testMode,
    wakeBufferMs: testMode
      ? parseBoundedNumber(env.CC_AUTORESUME_WAKE_BUFFER_MS, 30_000, 0, Number.POSITIVE_INFINITY, 'CC_AUTORESUME_WAKE_BUFFER_MS')
      : 30_000,
    targetCommandOverride: testMode ? env.CC_AUTORESUME_TARGET_COMMAND : undefined,
    defaultWaitHours: parseBoundedNumber(env.CC_AUTORESUME_DEFAULT_WAIT_HOURS, 5, 0.01, Number.POSITIVE_INFINITY, 'CC_AUTORESUME_DEFAULT_WAIT_HOURS'),
    disableScreenScan: parseBoolean(env.CC_AUTORESUME_DISABLE_SCREEN_SCAN),
    disableApiPoll: resolveDisableApiPoll(env),
    triggersFile: expandHome(env.CC_AUTORESUME_TRIGGERS_FILE ?? '~/.cc-autoresume/triggers.json'),
    restoreMaxAgeHours: parseBoundedNumber(env.CC_AUTORESUME_RESTORE_MAX_AGE_HOURS, 24, 0.01, Number.POSITIVE_INFINITY, 'CC_AUTORESUME_RESTORE_MAX_AGE_HOURS'),
  };
}

function parseBoolean(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  return value === '1' || value.toLowerCase() === 'true';
}

// API 轮询从 v0.2 起默认关闭：屏幕扫描已经覆盖所有触发场景，API 调用仅在屏幕触发时按需取 reset 时间
// - 默认行为：关闭（disableApiPoll = true）
// - 新 opt-in: CC_AUTORESUME_ENABLE_API_POLL=1
// - 旧兼容:   CC_AUTORESUME_DISABLE_API_POLL=1（显式关闭，老脚本无感）
function resolveDisableApiPoll(env: NodeJS.ProcessEnv): boolean {
  if (parseBoolean(env.CC_AUTORESUME_DISABLE_API_POLL)) return true;
  if (parseBoolean(env.CC_AUTORESUME_ENABLE_API_POLL)) return false;
  return true; // 新默认
}

export function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseArgs(argv: string[]): { target?: string; targetArgs: string[] } {
  let target: string | undefined;
  const targetArgs: string[] = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (passthrough) {
      targetArgs.push(arg);
      continue;
    }

    if (arg === '--') {
      passthrough = true;
      continue;
    }

    if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length);
      continue;
    }
    if (arg === '--target') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error('--target 需要一个值');
      target = value;
      index += 1;
      continue;
    }

    // wrapper 不认识的参数一律透传给目标 CLI
    targetArgs.push(arg);
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
