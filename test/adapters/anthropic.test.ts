import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicAdapter, parseAnthropicUsageResponse } from '../../src/adapters/anthropic';
import { isAdapterError, isSubscriptionSnapshot } from '../../src/adapters/types';

describe('parseAnthropicUsageResponse', () => {
  it('解析常见窗口字段', () => {
    const parsed = parseAnthropicUsageResponse({
      usage: {
        five_hour: { utilization: 0.5, resets_at: '2026-05-20T10:00:00.000Z' },
        seven_day: { utilization: 99, resets_at: Date.parse('2026-05-20T10:00:00.000Z') },
      },
    }, 123);

    expect(parsed?.fetched_at).toBe(123);
    expect(parsed?.five_hour?.utilization).toBe(50);
    expect(parsed?.seven_day?.utilization).toBe(99);
    expect(parsed?.seven_day?.resets_at).toBe('2026-05-20T10:00:00.000Z');
  });
});

describe('anthropicAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('请求成功时返回订阅快照', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        fiveHour: { utilization: 80, resetsAt: '2026-05-20T10:00:00.000Z' },
      }),
    })));

    const result = await anthropicAdapter.fetch({ ANTHROPIC_AUTH_TOKEN: 'token' });

    expect(isSubscriptionSnapshot(result)).toBe(true);
    if (isSubscriptionSnapshot(result)) expect(result.five_hour?.utilization).toBe(80);
  });

  it('401/403 归类为认证失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 })));

    const result = await anthropicAdapter.fetch({ ANTHROPIC_AUTH_TOKEN: 'token' });

    expect(isAdapterError(result)).toBe(true);
    if (isAdapterError(result)) expect(result.authFailed).toBe(true);
  });

  it('缺 token 时返回认证错误', async () => {
    const result = await anthropicAdapter.fetch({});

    expect(isAdapterError(result)).toBe(true);
    if (isAdapterError(result)) expect(result.authFailed).toBe(true);
  });
});
