import { shouldWakeAfterVerify } from './state-machine';
import type { AdapterResult, UsageAdapter } from './adapters/types';
import { isAdapterError, isSubscriptionSnapshot } from './adapters/types';

export type SchedulerEvent =
  | { type: 'wake-due' }
  | { type: 'verify-pushed'; attempt: number; nextWakeAt: string; error?: string }
  | { type: 'error'; error: string };

export interface TimerApi {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  now(): number;
}

export interface SchedulerOptions {
  adapter: UsageAdapter;
  env: NodeJS.ProcessEnv;
  threshold: number;
  onEvent: (event: SchedulerEvent) => void | Promise<void>;
  timer?: TimerApi;
  defaultWaitMs?: number;
  disableWakeHeartbeat?: boolean;
  heartbeatIntervalMs?: number;
}

export class Scheduler {
  private stopped = true;
  private wakeTimer?: unknown;
  private heartbeatTimer?: unknown;
  private wakeAtMsCached?: number;
  private wakeFired = false;
  private verifyAttempt = 0;
  private skipVerifyForCurrentPause = false;
  private readonly timer: TimerApi;
  private readonly defaultWaitMs: number;
  private readonly heartbeatIntervalMs: number;

  constructor(private readonly options: SchedulerOptions) {
    this.timer = options.timer ?? realTimer;
    this.defaultWaitMs = options.defaultWaitMs ?? 5 * 60 * 60 * 1000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 60_000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    this.clearWakeTimers();
  }

  resumePolling(): void {
    if (this.stopped) return;
    this.clearWakeTimers();
    this.verifyAttempt = 0;
    this.skipVerifyForCurrentPause = false;
  }

  pauseUntil(wakeAt: string, options: { skipVerify?: boolean } = {}): void {
    const wakeAtMs = new Date(wakeAt).getTime();
    if (!Number.isFinite(wakeAtMs)) {
      void this.emit({ type: 'error', error: `无效的唤醒时间：${wakeAt}` });
      return;
    }
    this.skipVerifyForCurrentPause = options.skipVerify ?? false;
    this.scheduleWake(wakeAtMs);
  }

  private scheduleWake(wakeAtMs: number): void {
    this.clearWakeTimers();
    if (this.stopped) return;
    this.wakeAtMsCached = wakeAtMs;
    this.wakeFired = false;

    const delayMs = Math.max(0, wakeAtMs - this.timer.now());
    this.wakeTimer = this.timer.setTimeout(() => this.fireWakeOnce(), delayMs);

    if (!this.options.disableWakeHeartbeat) {
      this.heartbeatTimer = this.timer.setInterval(() => {
        if (this.wakeAtMsCached !== undefined && this.timer.now() >= this.wakeAtMsCached) {
          this.fireWakeOnce();
        }
      }, this.heartbeatIntervalMs);
    }
  }

  private fireWakeOnce(): void {
    if (this.wakeFired || this.stopped) return;
    this.wakeFired = true;
    this.clearWakeTimers();
    if (this.skipVerifyForCurrentPause) {
      void this.emit({ type: 'wake-due' });
      return;
    }
    void this.verifyBeforeWake();
  }

  private async verifyBeforeWake(): Promise<void> {
    if (this.stopped) return;
    this.verifyAttempt += 1;
    const result = await this.options.adapter.fetch(this.options.env);

    if (shouldWake(result, this.options.threshold)) {
      this.verifyAttempt = 0;
      await this.emit({ type: 'wake-due' });
      return;
    }

    const error = isAdapterError(result) ? result.error : 'usage 仍未降到安全阈值';
    const nextWakeAtMs = this.timer.now() + this.defaultWaitMs;
    await this.emit({
      type: 'verify-pushed',
      attempt: this.verifyAttempt,
      nextWakeAt: new Date(nextWakeAtMs).toISOString(),
      error,
    });
    this.scheduleWake(nextWakeAtMs);
  }

  private clearWakeTimers(): void {
    if (this.wakeTimer !== undefined) this.timer.clearTimeout(this.wakeTimer);
    if (this.heartbeatTimer !== undefined) this.timer.clearInterval(this.heartbeatTimer);
    this.wakeTimer = undefined;
    this.heartbeatTimer = undefined;
    this.wakeAtMsCached = undefined;
  }

  private async emit(event: SchedulerEvent): Promise<void> {
    await this.options.onEvent(event);
  }
}

function shouldWake(result: AdapterResult, threshold: number): boolean {
  return isSubscriptionSnapshot(result) && shouldWakeAfterVerify(result, threshold);
}

const realTimer: TimerApi = {
  setTimeout(callback, ms) {
    return setTimeout(callback, ms);
  },
  clearTimeout(id) {
    clearTimeout(id as NodeJS.Timeout);
  },
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
