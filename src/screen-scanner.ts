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
}

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

  let buffer = '';
  let busyState: BusyStateName = 'IDLE';
  let lastBusyAt = 0;
  let lastLimitFiredAt = Number.NEGATIVE_INFINITY;
  let paused = false;

  function feed(chunk: string): void {
    if (paused || chunk.length === 0) return;

    // 当前 chunk 更新 busy 状态（只看新输入，避免历史 marker 反复触发）
    if (options.triggerSet.busyMarkers.some((m) => m.test(chunk))) {
      busyState = 'BUSY';
      lastBusyAt = now();
    }
    if (options.triggerSet.idleMarkers.some((m) => m.test(chunk))) {
      busyState = 'IDLE';
    }

    buffer += chunk;
    if (buffer.length > bufferSize) buffer = buffer.slice(buffer.length - bufferSize);

    const t = now();
    if (t - lastLimitFiredAt < rateLimitDebounceMs) return;

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
