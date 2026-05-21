import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anthropicAdapter, invalidateAnthropicToken, parseAnthropicUsageResponse, readAnthropicToken } from '../../src/adapters/anthropic';
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
  beforeEach(() => {
    invalidateAnthropicToken();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    invalidateAnthropicToken();
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

  it('成功读取后缓存 token，第二次调用复用', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ fiveHour: { utilization: 50 } }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    await anthropicAdapter.fetch({ ANTHROPIC_AUTH_TOKEN: 'cached-token' });
    // 第二次：把环境变量改掉，验证仍然用的是缓存的旧 token（不会从 env 重读）
    await anthropicAdapter.fetch({ ANTHROPIC_AUTH_TOKEN: 'this-should-be-ignored' });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // 两次都用第一次缓存的 token
    expect((fetchSpy.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer cached-token',
    });
    expect((fetchSpy.mock.calls[1][1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer cached-token',
    });
  });

  it('收到 401 时清缓存，下次重读环境变量', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ fiveHour: { utilization: 50 } }),
      });
    vi.stubGlobal('fetch', fetchSpy);

    await anthropicAdapter.fetch({ ANTHROPIC_AUTH_TOKEN: 'stale-token' });
    // 401 应该已经触发了 invalidateAnthropicToken()
    await anthropicAdapter.fetch({ ANTHROPIC_AUTH_TOKEN: 'fresh-token' });

    expect((fetchSpy.mock.calls[1][1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer fresh-token',
    });
  });

  it('readAnthropicToken 缓存命中后直接复用，不再走 env / IO', async () => {
    // 第一次：从环境变量拿到，写入缓存
    const t1 = await readAnthropicToken({ ANTHROPIC_AUTH_TOKEN: 'first' });
    expect(t1).toBe('first');

    // 第二次：环境变量改了但缓存还在，应该返回旧值
    const t2 = await readAnthropicToken({ ANTHROPIC_AUTH_TOKEN: 'second' });
    expect(t2).toBe('first');

    // 失效后才会重读
    invalidateAnthropicToken();
    const t3 = await readAnthropicToken({ ANTHROPIC_AUTH_TOKEN: 'third' });
    expect(t3).toBe('third');
  });

  it('缺 token 时返回认证错误（非 macOS / Keychain 无项）', async () => {
    // 强制走非 Keychain 分支：用 HOME=/tmp 让 ~/.claude/.credentials.json 也读不到
    const originalPlatform = process.platform;
    const originalHome = process.env.HOME;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    process.env.HOME = '/tmp/cc-autoresume-test-no-home';
    try {
      const result = await anthropicAdapter.fetch({});
      expect(isAdapterError(result)).toBe(true);
      if (isAdapterError(result)) expect(result.authFailed).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      if (originalHome) process.env.HOME = originalHome;
      else delete process.env.HOME;
    }
  });
});
