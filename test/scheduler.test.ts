import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scheduler, type SchedulerEvent } from '../src/scheduler';
import type { UsageAdapter } from '../src/adapters/types';

const timer = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (id: unknown) => clearTimeout(id as NodeJS.Timeout),
  setInterval: (callback: () => void, ms: number) => setInterval(callback, ms),
  clearInterval: (id: unknown) => clearInterval(id as NodeJS.Timeout),
  now: () => Date.now(),
};

function makeAdapter(fetch = vi.fn()): UsageAdapter {
  return {
    id: 'mock-test',
    kind: 'mock',
    matches: () => true,
    fetch,
  };
}

describe('Scheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start 不主动轮询 usage adapter', async () => {
    vi.useFakeTimers();
    const adapter = makeAdapter();
    const scheduler = new Scheduler({
      adapter,
      env: {},
      threshold: 99,
      onEvent: () => {},
      timer,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(adapter.fetch).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('pauseUntil(skipVerify=true) 到点时直接 wake-due，不调 verify', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T00:00:00.000Z'));
    const adapter = makeAdapter();
    const events: SchedulerEvent[] = [];
    const scheduler = new Scheduler({
      adapter,
      env: {},
      threshold: 99,
      onEvent: (e) => { events.push(e); },
      timer,
    });

    scheduler.start();
    scheduler.pauseUntil(new Date(Date.now() + 500).toISOString(), { skipVerify: true });
    await vi.advanceTimersByTimeAsync(500);

    expect(events.some((e) => e.type === 'wake-due')).toBe(true);
    expect(events.some((e) => e.type === 'verify-pushed')).toBe(false);
    expect(adapter.fetch).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('pauseUntil 默认在唤醒前 verify，通过后发出 wake-due', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T00:00:00.000Z'));
    const resetAt = new Date(Date.now() + 500).toISOString();
    const adapter = makeAdapter(vi.fn(async () => ({
      kind: 'subscription',
      fetched_at: Date.now(),
      five_hour: { utilization: 0, resets_at: resetAt },
    })));
    const events: SchedulerEvent[] = [];
    const scheduler = new Scheduler({
      adapter,
      env: {},
      threshold: 99,
      onEvent: (event) => { events.push(event); },
      timer,
    });

    scheduler.start();
    scheduler.pauseUntil(new Date(Date.now() + 500).toISOString());
    await vi.advanceTimersByTimeAsync(500);

    expect(adapter.fetch).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === 'wake-due')).toBe(true);
    scheduler.stop();
  });

  it('verify 失败时发出 verify-pushed 并把下次唤醒推后 defaultWaitMs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T00:00:00.000Z'));
    const resetAt = new Date(Date.now() + 500).toISOString();
    const adapter = makeAdapter(vi.fn(async () => ({
      kind: 'subscription',
      fetched_at: Date.now(),
      five_hour: { utilization: 100, resets_at: resetAt },
    })));
    const events: SchedulerEvent[] = [];
    const scheduler = new Scheduler({
      adapter,
      env: {},
      threshold: 99,
      defaultWaitMs: 60_000,
      onEvent: (event) => { events.push(event); },
      timer,
    });

    scheduler.start();
    scheduler.pauseUntil(new Date(Date.now() + 500).toISOString());
    await vi.advanceTimersByTimeAsync(500);

    const pushed = events.find((e) => e.type === 'verify-pushed');
    expect(pushed).toBeDefined();
    if (pushed?.type === 'verify-pushed') {
      expect(new Date(pushed.nextWakeAt).getTime()).toBe(Date.now() + 60_000);
    }
    expect(events.some((e) => e.type === 'wake-due')).toBe(false);
    scheduler.stop();
  });

  it('墙钟心跳兜底：setTimeout 没 fire 但 Date.now() 已过 wake_at 时触发 wake-due', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T00:00:00.000Z'));

    const stuckTimer = {
      setTimeout: (_cb: () => void, _ms: number) => 'stuck-timer-id',
      clearTimeout: () => {},
      setInterval: (callback: () => void, ms: number) => setInterval(callback, ms),
      clearInterval: (id: unknown) => clearInterval(id as NodeJS.Timeout),
      now: () => Date.now(),
    };

    const adapter = makeAdapter();
    const events: SchedulerEvent[] = [];
    const scheduler = new Scheduler({
      adapter,
      env: {},
      threshold: 99,
      heartbeatIntervalMs: 1000,
      onEvent: (e) => { events.push(e); },
      timer: stuckTimer,
    });

    scheduler.start();
    scheduler.pauseUntil(new Date(Date.now() + 5000).toISOString(), { skipVerify: true });
    await vi.advanceTimersByTimeAsync(6000);

    expect(events.some((e) => e.type === 'wake-due')).toBe(true);
    scheduler.stop();
  });

  it('幂等 fire：setTimeout 先 fire 后心跳不再 fire 第二次', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T00:00:00.000Z'));

    const adapter = makeAdapter();
    const events: SchedulerEvent[] = [];
    const scheduler = new Scheduler({
      adapter,
      env: {},
      threshold: 99,
      heartbeatIntervalMs: 1000,
      onEvent: (e) => { events.push(e); },
      timer,
    });

    scheduler.start();
    scheduler.pauseUntil(new Date(Date.now() + 500).toISOString(), { skipVerify: true });
    await vi.advanceTimersByTimeAsync(3000);

    const wakeEvents = events.filter((e) => e.type === 'wake-due');
    expect(wakeEvents).toHaveLength(1);
    scheduler.stop();
  });

  it('disableWakeHeartbeat=true 时不启动心跳（setTimeout 不 fire 时 wake-due 不会触发）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T00:00:00.000Z'));

    const stuckTimer = {
      setTimeout: (_cb: () => void, _ms: number) => 'stuck-timer-id',
      clearTimeout: () => {},
      setInterval: (_cb: () => void, _ms: number) => 'stuck-interval-id',
      clearInterval: () => {},
      now: () => Date.now(),
    };
    let intervalCreated = false;
    const trackingTimer = {
      ...stuckTimer,
      setInterval: (cb: () => void, ms: number) => {
        intervalCreated = true;
        return stuckTimer.setInterval(cb, ms);
      },
    };

    const adapter = makeAdapter();
    const events: SchedulerEvent[] = [];
    const scheduler = new Scheduler({
      adapter,
      env: {},
      threshold: 99,
      disableWakeHeartbeat: true,
      heartbeatIntervalMs: 1000,
      onEvent: (e) => { events.push(e); },
      timer: trackingTimer,
    });

    scheduler.start();
    scheduler.pauseUntil(new Date(Date.now() + 500).toISOString(), { skipVerify: true });
    await vi.advanceTimersByTimeAsync(3000);

    expect(intervalCreated).toBe(false);
    expect(events.some((e) => e.type === 'wake-due')).toBe(false);
    scheduler.stop();
  });
});
