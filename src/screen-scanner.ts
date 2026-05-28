import { extractResetTime, findLimitMatch, type TriggerSet } from './triggers';

export interface ScreenScanResult {
  trigger: 'screen';
  matchedPattern: string;
  extractedResetMs?: number;
}

export type BusyStateName = 'BUSY' | 'IDLE';

export interface BusyState {
  state: BusyStateName;
  lastBusyAt: number;
}

export interface ScreenScannerOptions {
  triggerSet: TriggerSet;
  onLimitHit: (result: ScreenScanResult) => void;
  now?: () => number;
  busyDebounceMs?: number;
  rateLimitDebounceMs?: number;
  bufferSize?: number;
  recentBusyMs?: number;
}

// CSI 序列剥离。会同时吃掉 \x1b[?25l/h 这类逻辑标志，
// 所以 busy/idle marker 检查必须跑在原 chunk 上，不能用剥离后的内容
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export interface ScreenScanner {
  feed(chunk: string): void;
  getBusyState(): BusyState;
  reset(): void;
  pause(): void;
  resume(): void;
}

export function createScreenScanner(options: ScreenScannerOptions): ScreenScanner {
  const now = options.now ?? (() => Date.now());
  const busyDebounceMs = options.busyDebounceMs ?? 2000;
  const rateLimitDebounceMs = options.rateLimitDebounceMs ?? 300;
  const bufferSize = options.bufferSize ?? 4096;
  const recentBusyMs = options.recentBusyMs ?? 10_000;

  let buffer = '';
  let busyState: BusyStateName = 'IDLE';
  let lastBusyAt = Number.NEGATIVE_INFINITY;
  let lastLimitFiredAt = Number.NEGATIVE_INFINITY;
  let paused = false;

  function feed(chunk: string): void {
    if (paused || chunk.length === 0) return;

    // busy/idle marker 必须用原 chunk——\x1b[?25l 这类标志依赖 ANSI 残留
    if (options.triggerSet.busyMarkers.some((m) => m.test(chunk))) {
      busyState = 'BUSY';
      lastBusyAt = now();
    }
    if (options.triggerSet.idleMarkers.some((m) => m.test(chunk))) {
      busyState = 'IDLE';
    }

    // 剥离 ANSI 后再进 buffer，限额 pattern 不会被字间颜色码切断
    buffer += chunk.replace(ANSI_RE, '');
    if (buffer.length > bufferSize) buffer = buffer.slice(buffer.length - bufferSize);

    const t = now();
    if (t - lastLimitFiredAt < rateLimitDebounceMs) return;

    // 只有 CLI 最近处于 BUSY 状态才触发——IDLE 下出现的错误文本是用户粘贴，不是真实报错
    if (busyState !== 'BUSY' && t - lastBusyAt > recentBusyMs) return;

    const match = findLimitMatch(buffer, options.triggerSet);
    if (!match) return;

    lastLimitFiredAt = t;
    const extractedResetMs = extractResetTime(buffer, options.triggerSet.resetExtractors, t);
    options.onLimitHit({
      trigger: 'screen',
      matchedPattern: match.pattern.source,
      extractedResetMs,
    });
  }

  function getBusyState(): BusyState {
    if (busyState === 'BUSY' && now() - lastBusyAt > busyDebounceMs) {
      busyState = 'IDLE';
    }
    return { state: busyState, lastBusyAt };
  }

  function reset(): void {
    buffer = '';
    lastLimitFiredAt = Number.NEGATIVE_INFINITY;
  }

  function pause(): void {
    paused = true;
  }

  function resume(): void {
    paused = false;
  }

  return { feed, getBusyState, reset, pause, resume };
}
