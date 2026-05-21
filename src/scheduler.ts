import { classifyPause, decideWakeAt, shouldWakeAfterVerify } from './state-machine';
import type { PauseTrigger } from './state-machine';
import type { AdapterError, BalanceUsageSnapshot, SubscriptionUsageSnapshot, UsageAdapter, UsageSnapshot } from './adapters/types';
import { isAdapterError, isBalanceSnapshot, isSubscriptionSnapshot } from './adapters/types';

export type SchedulerEvent =
  | { type: 'snapshot'; snapshot: UsageSnapshot }
  | { type: 'balance-warning'; snapshot: BalanceUsageSnapshot }
  | { type: 'pause-due'; trigger: Exclude<PauseTrigger, 'screen' | 'manual' | null>; resetsAt: string; wakeAt: string; mode: 'paused' | 'paused_long' }
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
  maxWaitHours: number;
  balanceWarn: number;
  wakeBufferMs: number;
  onEvent: (event: SchedulerEvent) => void | Promise<void>;
  timer?: TimerApi;
  defaultWaitMs?: number;     // verify 失败后顺延这么久重试，默认 5h
  disablePolling?: boolean;   // 关闭主动轮询（屏幕扫描单跑模式）；同时跳过唤醒前 verify
  disableWakeHeartbeat?: boolean;  // 关闭 paused 期间的墙钟心跳兜底（用于关心开销的极端场景）
  heartbeatIntervalMs?: number;    // 心跳间隔，默认 60s；测试可调小
}

export class Scheduler {
  private stopped = true;
  private pollTimer?: unknown;
  private wakeTimer?: unknown;
  private verifyTimer?: unknown;
  private heartbeatTimer?: unknown;       // 墙钟心跳兜底（修 Mac 休眠后 setTimeout 延迟 fire 的问题）
  private wakeAtMsCached?: number;        // 心跳回调里跟 Date.now() 比较的目标时间
  private wakeFired = false;              // 幂等保护：setTimeout 和心跳任一先 fire 后另一个跳过
  private failureCount = 0;
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
    if (this.options.disablePolling) return;
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
    this.skipVerifyForCurrentPause = false;
    this.schedulePoll(0);
  }

  pauseUntil(wakeAt: string, options: { skipVerify?: boolean } = {}): void {
    const wakeAtMs = new Date(wakeAt).getTime();
    if (!Number.isFinite(wakeAtMs)) {
      void this.emit({ type: 'error', error: `无效的唤醒时间：${wakeAt}` });
      return;
    }
    this.clearPollTimer();
    this.skipVerifyForCurrentPause = options.skipVerify ?? false;
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
    if (mode === 'paused') {
      // API 路径触发的暂停一定要 verify（默认值），重置 flag
      this.skipVerifyForCurrentPause = false;
      this.scheduleWake(decision.wakeAtMs);
    }
  }

  private async handleAdapterError(error: AdapterError): Promise<void> {
    this.failureCount += 1;
    await this.emit({ type: 'error', error: error.error });
    this.schedulePoll(nextBackoffMs(error, this.failureCount));
  }

  private scheduleWake(wakeAtMs: number): void {
    this.clearWakeTimers();
    if (this.stopped) return;
    this.wakeAtMsCached = wakeAtMs;
    this.wakeFired = false;

    const delayMs = Math.max(0, wakeAtMs - this.timer.now());
    this.wakeTimer = this.timer.setTimeout(() => this.fireWakeOnce(), delayMs);

    // 墙钟心跳兜底：Node setTimeout 在 Mac 长时间休眠下会按"在线时间"算 delay，
    // 导致 wake_at 晚 fire 数小时。心跳每 N 秒检查一次 Date.now()，超过 wake_at 就立刻 fire
    if (!this.options.disableWakeHeartbeat) {
      this.heartbeatTimer = this.timer.setInterval(() => {
        if (this.wakeAtMsCached !== undefined && Date.now() >= this.wakeAtMsCached) {
          this.fireWakeOnce();
        }
      }, this.heartbeatIntervalMs);
    }
  }

  private fireWakeOnce(): void {
    if (this.wakeFired || this.stopped) return;
    this.wakeFired = true;
    this.clearWakeTimers();  // 清掉 setTimeout / verifyTimer / heartbeatTimer
    if (this.options.disablePolling || this.skipVerifyForCurrentPause) {
      void this.emit({ type: 'wake-due' });
      return;
    }
    void this.verifyBeforeWake();
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
    const nextWakeAtMs = this.timer.now() + this.defaultWaitMs;
    await this.emit({
      type: 'verify-pushed',
      attempt: this.verifyAttempt,
      nextWakeAt: new Date(nextWakeAtMs).toISOString(),
      error,
    });
    this.scheduleWake(nextWakeAtMs);
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
    if (this.heartbeatTimer !== undefined) this.timer.clearInterval(this.heartbeatTimer);
    this.wakeTimer = undefined;
    this.verifyTimer = undefined;
    this.heartbeatTimer = undefined;
    this.wakeAtMsCached = undefined;
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
