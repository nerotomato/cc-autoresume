import type { SubscriptionUsageSnapshot } from './adapters/types';

export type RuntimeStateName = 'idle' | 'running' | 'paused' | 'waking' | 'error';
export type PauseTrigger = '5h' | '7d' | 'both' | 'screen' | 'manual' | null;
export type WakeSource = 'text' | 'api' | 'statusline' | 'default';

export interface ScreenWakeDecision {
  wakeAtMs: number;
  source: WakeSource;
}

export interface RuntimeState {
  state: RuntimeStateName;
  trigger: PauseTrigger;
  target: string;
  adapterId?: string;
  pausedAt?: string;
  resetsAt?: string;
  wakeAt?: string;
  pid?: number;
  error?: string;
}

export interface WakeDecision {
  trigger: Exclude<PauseTrigger, 'screen' | 'manual' | null>;
  resetsAt: string;
  wakeAtMs: number;
}

export function decideWakeAt(
  snapshot: SubscriptionUsageSnapshot,
  threshold: number,
  wakeBufferMs = 30_000,
): WakeDecision | null {
  const fiveHourExhausted = (snapshot.five_hour?.utilization ?? 0) >= threshold;
  const sevenDayExhausted = (snapshot.seven_day?.utilization ?? 0) >= threshold;

  if (!fiveHourExhausted && !sevenDayExhausted) return null;

  const fiveHourMs = fiveHourExhausted ? parseResetMs(snapshot.five_hour?.resets_at) : undefined;
  const sevenDayMs = sevenDayExhausted ? parseResetMs(snapshot.seven_day?.resets_at) : undefined;

  if (fiveHourExhausted && fiveHourMs === undefined) return null;
  if (sevenDayExhausted && sevenDayMs === undefined) return null;

  if (fiveHourExhausted && sevenDayExhausted) {
    const wakeAtMs = Math.max(fiveHourMs!, sevenDayMs!) + wakeBufferMs;
    return {
      trigger: 'both',
      resetsAt: new Date(Math.max(fiveHourMs!, sevenDayMs!)).toISOString(),
      wakeAtMs,
    };
  }

  if (fiveHourExhausted) {
    return {
      trigger: '5h',
      resetsAt: new Date(fiveHourMs!).toISOString(),
      wakeAtMs: fiveHourMs! + wakeBufferMs,
    };
  }

  return {
    trigger: '7d',
    resetsAt: new Date(sevenDayMs!).toISOString(),
    wakeAtMs: sevenDayMs! + wakeBufferMs,
  };
}


export function decideScreenWakeAt(
  extractedResetMs: number | undefined,
  apiResetMs: number | undefined,
  defaultWaitMs: number,
  nowMs: number,
  wakeBufferMs = 30_000,
): ScreenWakeDecision {
  // 优先用 CLI 文本里抽到的时间
  if (extractedResetMs !== undefined && Number.isFinite(extractedResetMs) && extractedResetMs > nowMs) {
    return { wakeAtMs: extractedResetMs + wakeBufferMs, source: 'text' };
  }
  // 次选 API 兜底
  if (apiResetMs !== undefined && Number.isFinite(apiResetMs) && apiResetMs > nowMs) {
    return { wakeAtMs: apiResetMs + wakeBufferMs, source: 'api' };
  }
  // 兜底默认值
  return { wakeAtMs: nowMs + defaultWaitMs, source: 'default' };
}

export function shouldWakeAfterVerify(snapshot: SubscriptionUsageSnapshot, threshold: number): boolean {
  const highest = Math.max(
    snapshot.five_hour?.utilization ?? 0,
    snapshot.seven_day?.utilization ?? 0,
  );
  return highest < threshold - 10;
}

function parseResetMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}
