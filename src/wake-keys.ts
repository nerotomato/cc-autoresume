export interface WritablePty {
  write(data: string): void;
}

export interface WakeSequenceOptions {
  target: 'claude' | 'codex' | 'ccs';
  resumeHint: string;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function sendWakeSequence(pty: WritablePty, options: WakeSequenceOptions): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  pty.write('\x1b');
  await sleep(options.delayMs ?? 200);
  pty.write(options.resumeHint);
  pty.write('\r');
}

// 命名按键到 ANSI 转义的映射
const KEY_TO_BYTES: Record<string, string> = {
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  enter: '\r',
  esc: '\x1b',
  tab: '\t',
  space: ' ',
};

export type KeyName = keyof typeof KEY_TO_BYTES | 'literal';

export interface KeySequenceStep {
  key: string;            // 命名键或 "literal"
  literal?: string;       // key=literal 时的字面内容
  delayAfterMs?: number;  // 默认 80ms
}

export interface SendKeySequenceOptions {
  defaultDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function sendKeySequence(
  pty: WritablePty,
  steps: KeySequenceStep[],
  options: SendKeySequenceOptions = {},
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const defaultDelayMs = options.defaultDelayMs ?? 80;

  for (const step of steps) {
    const bytes = stepToBytes(step);
    if (bytes === undefined) continue;
    pty.write(bytes);
    await sleep(step.delayAfterMs ?? defaultDelayMs);
  }
}

function stepToBytes(step: KeySequenceStep): string | undefined {
  if (step.key === 'literal') return step.literal;
  return KEY_TO_BYTES[step.key];
}

// 把用户配置的 "up,up,enter" 字符串解析成 step 数组
// 未知键名跳过（用户随便写不报错，方便兜底）
export function parseKeySequenceSteps(spec: string): KeySequenceStep[] {
  return spec
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0)
    .map((token): KeySequenceStep | undefined => {
      if (token in KEY_TO_BYTES) return { key: token };
      return undefined;
    })
    .filter((step): step is KeySequenceStep => step !== undefined);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
