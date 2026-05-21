import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scheduler, nextBackoffMs, nextIntervalMs, type SchedulerEvent } from '../src/scheduler';
import type { UsageAdapter } from '../src/adapters/types';

const timer = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (id: unknown) => clearTimeout(id as NodeJS.Timeout),
  now: () => Date.now(),
};

describe('nextIntervalMs', () => {
  it('按 utilization 水位返回间隔', () => {
    expect(nextIntervalMs({ kind: 'subscription', fetched_at: 0, five_hour: { utilization: 50 } })).toBe(10 * 60 * 1000);
    expect(nextIntervalMs({ kind: 'subscription', fetched_at: 0, five_hour: { utilization: 80 } })).toBe(2 * 60 * 1000);
    expect(nextIntervalMs({ kind: 'subscription', fetched_at: 0, five_hour: { utilization: 95 } })).toBe(30 * 1000);
    expect(nextIntervalMs({ kind: 'subscription', fetched_at: 0, five_hour: { utilization: 99 } })).toBe(10 * 1000);
  });
});

describe('nextBackoffMs', () => {
  it('本地错误前三次立即重试，随后退避', () => {
    expect(nextBackoffMs({ error: 'local' }, 1)).toBe(0);
    expect(nextBackoffMs({ error: 'local' }, 3)).toBe(0);
    expect(nextBackoffMs({ error: 'local' }, 4)).toBe(30_000);
  });

  it('认证和瞬时错误从 30s 开始退避', () => {
    expect(nextBackoffMs({ error: 'auth', authFailed: true }, 1)).toBe(30_000);
    expect(nextBackoffMs({ error: 'auth', authFailed: true }, 2)).toBe(60_000);
    expect(nextBackoffMs({ error: 'busy', transient: true }, 5)).toBe(300_000);
  });
});

describe('Scheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('订阅快照达到阈值时发出 pause-due，到点 verify 后发出 wake-due', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T00:00:00.000Z'));
    const resetAt = new Date(Date.now() + 1000).toISOString();
    const adapter: UsageAdapter = {
      id: 'mock-test',
      kind: 'mock',
      matches: () => true,
      fetch: vi.fn()
        .mockResolvedValueOnce({ kind: 'subscription', fetched_at: Date.now(), five_hour: { utilization: 100, resets_at: resetAt } })
        .mockResolvedValueOnce({ kind: 'subscription', fetched_at: Date.now(), five_hour: { utilization: 0, resets_at: resetAt } }),
    };
    const events: SchedulerEvent[] = [];
    const scheduler = new Scheduler({
      adapter,
      env: {},
      threshold: 99,
      maxWaitHours: 12,
      balanceWarn: 5,
      wakeBufferMs: 0,
      onEvent: (event) => {
        events.push(event);
      },
      timer,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.some((event) => event.type === 'pause-due' && event.mode === 'paused')).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(events.some((event) => event.type === 'wake-due')).toBe(true);
    scheduler.stop();
  });

  it('verify 失败时发出 verify-pushed 并把下次唤醒推后 defaultWaitMs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T00:00:00.000Z'));
    const resetAt = new Date(Date.now() + 1000).toISOString();
    const adapter: UsageAdapter = {
      id: 'mock-test',
      kind: 'mock',
      matches: () => true,
      fetch: vi.fn()
        // 首次拉取触发 pause
        .mockResolvedValueOnce({ kind: 'subscription', fetched_at: Date.now(), five_hour: { utilization: 100, resets_at: resetAt } })
        // 唤醒前 verify：仍然高
        .mockResolvedValueOnce({ kind: 'subscription', fetched_at: Date.now(), five_hour: { utilization: 100, resets_at: resetAt } }),
    };
    const events: SchedulerEvent[] = [];
    const scheduler = new Scheduler({
      adapter,
      env: {},
      threshold: 99,
      maxWaitHours: 12,
      balanceWarn: 5,
      wakeBufferMs: 0,
      defaultWaitMs: 60_000,
      onEvent: (event) => { events.push(event); },
      timer,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);

    const pushed = events.find((e) => e.type === 'verify-pushed');
    expect(pushed).toBeDefined();
    if (pushed?.type === 'verify-pushed') {
      expect(new Date(pushed.nextWakeAt).getTime()).toBe(Date.now() + 60_000);
    }
    expect(events.some((e) => e.type === 'wake-due')).toBe(false);
    scheduler.stop();
  });

  it('pauseUntil(skipVerify=true) 到点时直接 wake-due，不调 verify', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T00:00:00.000Z'));
    const adapter: UsageAdapter = {
      id: 'mock-test',
      kind: 'mock',
      matches: () => true,
      fetch: vi.fn(),
    };
    const events: SchedulerEvent[] = [];
    const scheduler = new Scheduler({
      adapter,
      env: {},
      threshold: 99,
      maxWaitHours: 12,
      balanceWarn: 5,
      wakeBufferMs: 0,
      onEvent: (e) => { events.push(e); },
      timer,
    });

    scheduler.start();
    // 屏幕扫描触发暂停时 wrapper 这样调用：
    scheduler.pauseUntil(new Date(Date.now() + 500).toISOString(), { skipVerify: true });
    await vi.advanceTimersByTimeAsync(500);

    expect(events.some((e) => e.type === 'wake-due')).toBe(true);
    expect(events.some((e) => e.type === 'verify-pushed')).toBe(false);
    expect(adapter.fetch).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('disablePolling 模式下 start 不触发轮询，但 pauseUntil 仍能唤醒', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T00:00:00.000Z'));
    const adapter: UsageAdapter = {
      id: 'mock-test',
      kind: 'mock',
      matches: () => true,
      fetch: vi.fn(),
    };
    const events: SchedulerEvent[] = [];
    const scheduler = new Scheduler({
      adapter,
      env: {},
      threshold: 99,
      maxWaitHours: 12,
      balanceWarn: 5,
      wakeBufferMs: 0,
      disablePolling: true,
      onEvent: (event) => { events.push(event); },
      timer,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(adapter.fetch).not.toHaveBeenCalled();

    scheduler.pauseUntil(new Date(Date.now() + 500).toISOString());
    await vi.advanceTimersByTimeAsync(500);

    // disablePolling 下到点直接发 wake-due，不调 verify
    expect(events.some((e) => e.type === 'wake-due')).toBe(true);
    expect(adapter.fetch).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('余额低于阈值时只发出 balance-warning', async () => {
    vi.useFakeTimers();
    const adapter: UsageAdapter = {
      id: 'balance-test',
      kind: 'mock',
      matches: () => true,
      fetch: vi.fn(async () => ({ kind: 'balance', provider: 'Mock', balance: 1, currency: 'CNY', fetched_at: Date.now() })),
    };
    const events: SchedulerEvent[] = [];
    const scheduler = new Scheduler({
      adapter,
      env: {},
      threshold: 99,
      maxWaitHours: 12,
      balanceWarn: 5,
      wakeBufferMs: 0,
      onEvent: (event) => {
        events.push(event);
      },
      timer,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(events.some((event) => event.type === 'balance-warning')).toBe(true);
    expect(events.some((event) => event.type === 'pause-due')).toBe(false);
    scheduler.stop();
  });
});
