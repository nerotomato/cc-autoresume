import fs from 'node:fs/promises';
import { decideWakeAt, type WakeDecision } from './state-machine';
import type { SubscriptionUsageSnapshot } from './adapters/types';

export interface RateLimitsWatcherOptions {
  filePath: string;
  threshold: number;
  pollIntervalMs: number;
  maxStalenessMs: number;
  wakeBufferMs: number;
  onLimitHit: (decision: WakeDecision, snapshot: SubscriptionUsageSnapshot) => void | Promise<void>;
  onError?: (error: string) => void | Promise<void>;
  timer?: TimerApi;
}

export interface TimerApi {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  now(): number;
}

export class RateLimitsWatcher {
  private interval?: unknown;
  private stopped = true;
  private triggered = false;
  private checking = false;
  private readonly timer: TimerApi;

  constructor(private readonly options: RateLimitsWatcherOptions) {
    this.timer = options.timer ?? realTimer;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.check();
    this.interval = this.timer.setInterval(() => {
      void this.check();
    }, this.options.pollIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.interval !== undefined) this.timer.clearInterval(this.interval);
    this.interval = undefined;
  }

  reset(): void {
    this.triggered = false;
  }

  async check(): Promise<void> {
    if (this.stopped || this.triggered || this.checking) return;
    this.checking = true;
    try {
      const stat = await fs.stat(this.options.filePath);
      if (this.timer.now() - stat.mtimeMs > this.options.maxStalenessMs) return;

      const raw = await fs.readFile(this.options.filePath, 'utf8');
      const snapshot = parseRateLimitsPayload(raw, this.timer.now());
      if (!snapshot) return;

      const decision = decideWakeAt(snapshot, this.options.threshold, this.options.wakeBufferMs);
      if (!decision) return;

      this.triggered = true;
      await this.options.onLimitHit(decision, snapshot);
    } catch (error) {
      if (isNotFound(error)) return;
      await this.options.onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      this.checking = false;
    }
  }
}

export function parseRateLimitsPayload(raw: string, fetchedAt = Date.now()): SubscriptionUsageSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const rateLimits = root.rate_limits;
  if (typeof rateLimits !== 'object' || rateLimits === null || Array.isArray(rateLimits)) return null;

  const record = rateLimits as Record<string, unknown>;
  const fiveHour = parseWindow(record.five_hour);
  const sevenDay = parseWindow(record.seven_day);
  if (!fiveHour && !sevenDay) return null;

  return {
    kind: 'subscription',
    fetched_at: fetchedAt,
    five_hour: fiveHour,
    seven_day: sevenDay,
  };
}

function parseWindow(value: unknown): SubscriptionUsageSnapshot['five_hour'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const utilization = parseNumber(record.used_percentage ?? record.utilization ?? record.used_percent ?? record.percent);
  if (utilization === undefined) return undefined;
  const resetsAt = parseResetAt(record.resets_at ?? record.resetsAt);
  return resetsAt ? { utilization, resets_at: resetsAt } : { utilization };
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseResetAt(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

const realTimer: TimerApi = {
  setInterval(callback, ms) {
    return setInterval(callback, ms);
  },
  clearInterval(id) {
    clearInterval(id as NodeJS.Timeout);
  },
  now() {
    return Date.now();
  },
};
