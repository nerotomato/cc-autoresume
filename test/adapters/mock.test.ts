import { describe, expect, it } from 'vitest';
import { createMockAdapter } from '../../src/adapters/mock';
import { isAdapterError, isBalanceSnapshot, isSubscriptionSnapshot } from '../../src/adapters/types';

describe('mock adapter', () => {
  it('生成订阅制快照并在 reset 后降低 utilization', async () => {
    let now = 1000;
    const adapter = createMockAdapter(() => now, 1000);
    const env = {
      CC_AUTORESUME_MOCK_KIND: 'subscription',
      CC_AUTORESUME_MOCK_5H_UTIL: '100',
      CC_AUTORESUME_MOCK_5H_RESET_IN_MS: '500',
    };

    const before = await adapter.fetch(env);
    now = 1600;
    const after = await adapter.fetch(env);

    expect(isSubscriptionSnapshot(before)).toBe(true);
    expect(isSubscriptionSnapshot(after)).toBe(true);
    if (isSubscriptionSnapshot(before) && isSubscriptionSnapshot(after)) {
      expect(before.five_hour?.utilization).toBe(100);
      expect(after.five_hour?.utilization).toBe(0);
    }
  });

  it('生成余额快照', async () => {
    const adapter = createMockAdapter(() => 1000, 1000);
    const result = await adapter.fetch({
      CC_AUTORESUME_MOCK_KIND: 'balance',
      CC_AUTORESUME_MOCK_PROVIDER: 'DeepSeek',
      CC_AUTORESUME_MOCK_BALANCE: '1.23',
      CC_AUTORESUME_MOCK_CURRENCY: 'CNY',
    });

    expect(isBalanceSnapshot(result)).toBe(true);
    if (isBalanceSnapshot(result)) {
      expect(result.provider).toBe('DeepSeek');
      expect(result.balance).toBe(1.23);
      expect(result.currency).toBe('CNY');
    }
  });

  it('生成错误结果', async () => {
    const adapter = createMockAdapter(() => 1000, 1000);
    const result = await adapter.fetch({ CC_AUTORESUME_MOCK_KIND: 'error', CC_AUTORESUME_MOCK_ERROR: 'auth' });

    expect(isAdapterError(result)).toBe(true);
    if (isAdapterError(result)) expect(result.authFailed).toBe(true);
  });
});
