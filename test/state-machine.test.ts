import { describe, expect, it } from 'vitest';
import { classifyPause, decideWakeAt, shouldWakeAfterVerify } from '../src/state-machine';
import type { SubscriptionUsageSnapshot } from '../src/adapters/types';

const base: SubscriptionUsageSnapshot = {
  kind: 'subscription',
  fetched_at: 0,
};

describe('state-machine', () => {
  it('仅 5h 饱和时取 5h reset 时间', () => {
    const reset = '2026-05-20T10:00:00.000Z';
    const decision = decideWakeAt({ ...base, five_hour: { utilization: 100, resets_at: reset }, seven_day: { utilization: 10 } }, 99, 1000);

    expect(decision?.trigger).toBe('5h');
    expect(decision?.resetsAt).toBe(reset);
    expect(decision?.wakeAtMs).toBe(new Date(reset).getTime() + 1000);
  });

  it('仅 7d 饱和时取 7d reset 时间', () => {
    const reset = '2026-05-27T10:00:00.000Z';
    const decision = decideWakeAt({ ...base, five_hour: { utilization: 10 }, seven_day: { utilization: 100, resets_at: reset } }, 99, 0);

    expect(decision?.trigger).toBe('7d');
    expect(decision?.resetsAt).toBe(reset);
  });

  it('双窗口饱和时取更晚 reset 时间', () => {
    const early = '2026-05-20T10:00:00.000Z';
    const late = '2026-05-21T10:00:00.000Z';
    const decision = decideWakeAt({ ...base, five_hour: { utilization: 100, resets_at: early }, seven_day: { utilization: 100, resets_at: late } }, 99, 0);

    expect(decision?.trigger).toBe('both');
    expect(decision?.resetsAt).toBe(late);
  });

  it('未达到阈值时不触发暂停', () => {
    const decision = decideWakeAt({ ...base, five_hour: { utilization: 80 }, seven_day: { utilization: 50 } }, 99);

    expect(decision).toBeNull();
  });

  it('达到阈值但缺少 resets_at 时不自动暂停', () => {
    const decision = decideWakeAt({ ...base, five_hour: { utilization: 100 } }, 99);

    expect(decision).toBeNull();
  });

  it('按最大等待时间区分 paused 和 paused_long', () => {
    const now = Date.parse('2026-05-20T00:00:00.000Z');

    expect(classifyPause(now + 2 * 60 * 60 * 1000, now, 12)).toBe('paused');
    expect(classifyPause(now + 13 * 60 * 60 * 1000, now, 12)).toBe('paused_long');
  });

  it('verify 需要低于 threshold - 10', () => {
    expect(shouldWakeAfterVerify({ ...base, five_hour: { utilization: 88 } }, 99)).toBe(true);
    expect(shouldWakeAfterVerify({ ...base, five_hour: { utilization: 90 } }, 99)).toBe(false);
  });
});
