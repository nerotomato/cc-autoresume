import { classifyPause, decideWakeAt, shouldWakeAfterVerify } from './state-machine';
import type { PauseTrigger } from './state-machine';
import type { AdapterError, BalanceUsageSnapshot, SubscriptionUsageSnapshot, UsageAdapter, UsageSnapshot } from './adapters/types';
import { isAdapterError, isBalanceSnapshot, isSubscriptionSnapshot } from './adapters/types';

export type SchedulerEvent =
  | { type: 'snapshot'; snapshot: UsageSnapshot }
  | { type: 'balance-warning'; snapshot: BalanceUsageSnapshot }
  | { type: 'pause-due'; trigger: Exclude<PauseTrigger, 'screen' | null>; resetsAt: string; wakeAt: string; mode: 'paused' | 'paused_long' }
  | { type: 'wake-due' }
  | { type: 'verify-failed'; attempt: number; maxAttempts: number; error?: string }
  | { type: 'error'; error: string };

export interface TimerApi {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  now(): number;
}

export interface SchedulerOptions {
  adapter: UsageAdapter;
  env: NodeJS.ProcessEnv;
  threshold: number;
  maxWaitHours: number;
  balanceWarn: number;
  wakeBufferMs: number;
  onEvent: (event: SchedulerEvent) => void | Promise<void>;
  timer?: TimerApi;
  maxVerifyAttempts?: number;
  verifyRetryMs?: number;
}

export class Scheduler {
  private stopped = true;
  private pollTimer?: unknown;
  private wakeTimer?: unknown;
  private verifyTimer?: unknown;
  private failureCount = 0;
  private verifyAttempt = 0;
  private readonly timer: TimerApi;
  private readonly maxVerifyAttempts: number;
  private readonly verifyRetryMs: number;

  constructor(private readonly options: SchedulerOptions) {
    this.timer = options.timer ?? realTimer;
    this.maxVerifyAttempts = options.maxVerifyAttempts ?? 5;
    this.verifyRetryMs = options.verifyRetryMs ?? 60_000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedulePoll(0);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
  }

  resumePolling(): void {
    if (this.stopped) return;
    this.clearWakeTimers();
    this.verifyAttempt = 0;
    this.failureCount = 0;
    this.schedulePoll(0);
  }

  pauseUntil(wakeAt: string): void {
    const wakeAtMs = new Date(wakeAt).getTime();
    if (!Number.isFinite(wakeAtMs)) {
      void this.emit({ type: 'error', error: `无效的唤醒时间：${wakeAt}` });
      return;
    }
    this.clearPollTimer();
    this.scheduleWake(wakeAtMs);
  }

  private schedulePoll(delayMs: number): void {
    this.clearPollTimer();
    if (this.stopped) return;
    this.pollTimer = this.timer.setTimeout(() => {
      void this.poll();
    }, Math.max(0, delayMs));
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    const result = await this.options.adapter.fetch(this.options.env);

    if (isAdapterError(result)) {
      await this.handleAdapterError(result);
      return;
    }

    this.failureCount = 0;
    await this.emit({ type: 'snapshot', snapshot: result });

    if (isBalanceSnapshot(result)) {
      if (result.balance <= this.options.balanceWarn) {
        await this.emit({ type: 'balance-warning', snapshot: result });
      }
      this.schedulePoll(10 * 60 * 1000);
      return;
    }

    if (isSubscriptionSnapshot(result)) {
      await this.handleSubscriptionSnapshot(result);
    }
  }

  private async handleSubscriptionSnapshot(snapshot: SubscriptionUsageSnapshot): Promise<void> {
    const decision = decideWakeAt(snapshot, this.options.threshold, this.options.wakeBufferMs);
    if (!decision) {
      this.schedulePoll(nextIntervalMs(snapshot));
      return;
    }

    const mode = classifyPause(decision.wakeAtMs, this.timer.now(), this.options.maxWaitHours);
    const wakeAt = new Date(decision.wakeAtMs).toISOString();
    await this.emit({
      type: 'pause-due',
      trigger: decision.trigger,
      resetsAt: decision.resetsAt,
      wakeAt,
      mode,
    });

    this.clearPollTimer();
    if (mode === 'paused') this.scheduleWake(decision.wakeAtMs);
  }

  private async handleAdapterError(error: AdapterError): Promise<void> {
    this.failureCount += 1;
    await this.emit({ type: 'error', error: error.error });
    this.schedulePoll(nextBackoffMs(error, this.failureCount));
  }

  private scheduleWake(wakeAtMs: number): void {
    this.clearWakeTimers();
    if (this.stopped) return;
    const delayMs = Math.max(0, wakeAtMs - this.timer.now());
    this.wakeTimer = this.timer.setTimeout(() => {
      void this.verifyBeforeWake();
    }, delayMs);
  }

  private async verifyBeforeWake(): Promise<void> {
    if (this.stopped) return;
    this.verifyAttempt += 1;
    const result = await this.options.adapter.fetch(this.options.env);

    if (isSubscriptionSnapshot(result) && shouldWakeAfterVerify(result, this.options.threshold)) {
      this.verifyAttempt = 0;
      await this.emit({ type: 'wake-due' });
      return;
    }

    const error = isAdapterError(result) ? result.error : 'usage 仍未降到安全阈值';
    await this.emit({ type: 'verify-failed', attempt: this.verifyAttempt, maxAttempts: this.maxVerifyAttempts, error });

    if (this.verifyAttempt >= this.maxVerifyAttempts) {
      await this.emit({ type: 'error', error: '唤醒前校验达到最大重试次数，请手动处理当前 CLI' });
      return;
    }

    this.verifyTimer = this.timer.setTimeout(() => {
      void this.verifyBeforeWake();
    }, this.verifyRetryMs);
  }

  private clearTimers(): void {
    this.clearPollTimer();
    this.clearWakeTimers();
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== undefined) this.timer.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private clearWakeTimers(): void {
    if (this.wakeTimer !== undefined) this.timer.clearTimeout(this.wakeTimer);
    if (this.verifyTimer !== undefined) this.timer.clearTimeout(this.verifyTimer);
    this.wakeTimer = undefined;
    this.verifyTimer = undefined;
  }

  private async emit(event: SchedulerEvent): Promise<void> {
    await this.options.onEvent(event);
  }
}

export function nextIntervalMs(snapshot: SubscriptionUsageSnapshot): number {
  const highest = Math.max(
    snapshot.five_hour?.utilization ?? 0,
    snapshot.seven_day?.utilization ?? 0,
  );

  if (highest < 80) return 10 * 60 * 1000;
  if (highest < 95) return 2 * 60 * 1000;
  if (highest < 99) return 30 * 1000;
  return 10 * 1000;
}

export function nextBackoffMs(error: AdapterError, failureCount: number): number {
  if (!error.authFailed && !error.transient && failureCount <= 3) return 0;
  const adjustedCount = error.authFailed || error.transient ? failureCount : failureCount - 3;
  return Math.min(30_000 * 2 ** Math.max(0, adjustedCount - 1), 300_000);
}

const realTimer: TimerApi = {
  setTimeout(callback, ms) {
    return setTimeout(callback, ms);
  },
  clearTimeout(id) {
    clearTimeout(id as NodeJS.Timeout);
  },
  now() {
    return Date.now();
  },
};
