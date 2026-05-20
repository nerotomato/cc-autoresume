import type { AdapterError, BalanceUsageSnapshot, SubscriptionUsageSnapshot, UsageAdapter } from './types';

export function createMockAdapter(now: () => number = () => Date.now(), startedAt = now()): UsageAdapter {
  return {
    id: 'mock',
    kind: 'mock',
    matches: () => true,
    async fetch(env) {
      const kind = env.CC_AUTORESUME_MOCK_KIND ?? 'subscription';
      if (kind === 'error') return mockError(env.CC_AUTORESUME_MOCK_ERROR);
      if (kind === 'balance') return mockBalance(env, now());
      return mockSubscription(env, now(), startedAt);
    },
  };
}

export const mockAdapter = createMockAdapter();

function mockSubscription(env: NodeJS.ProcessEnv, nowMs: number, startedAt: number): SubscriptionUsageSnapshot {
  return {
    kind: 'subscription',
    five_hour: mockWindow(env.CC_AUTORESUME_MOCK_5H_UTIL, env.CC_AUTORESUME_MOCK_5H_RESET_IN_MS, env.CC_AUTORESUME_MOCK_5H_AFTER_RESET_UTIL, nowMs, startedAt),
    seven_day: mockWindow(env.CC_AUTORESUME_MOCK_7D_UTIL, env.CC_AUTORESUME_MOCK_7D_RESET_IN_MS, env.CC_AUTORESUME_MOCK_7D_AFTER_RESET_UTIL, nowMs, startedAt),
    fetched_at: nowMs,
  };
}

function mockWindow(
  utilizationValue: string | undefined,
  resetInValue: string | undefined,
  afterResetValue: string | undefined,
  nowMs: number,
  startedAt: number,
) {
  const utilization = parseNumber(utilizationValue, 0);
  const resetInMs = parseNumber(resetInValue, 60_000);
  const resetAtMs = startedAt + resetInMs;
  const afterResetUtilization = parseNumber(afterResetValue, 0);

  return {
    utilization: nowMs >= resetAtMs ? afterResetUtilization : utilization,
    resets_at: new Date(resetAtMs).toISOString(),
  };
}

function mockBalance(env: NodeJS.ProcessEnv, nowMs: number): BalanceUsageSnapshot {
  return {
    kind: 'balance',
    provider: env.CC_AUTORESUME_MOCK_PROVIDER ?? 'MockProvider',
    balance: parseNumber(env.CC_AUTORESUME_MOCK_BALANCE, 0),
    currency: env.CC_AUTORESUME_MOCK_CURRENCY,
    fetched_at: nowMs,
  };
}

function mockError(kind = 'local'): AdapterError {
  if (kind === 'auth') return { error: 'mock auth failed', status: 401, authFailed: true };
  if (kind === 'transient') return { error: 'mock transient error', status: 503, transient: true };
  return { error: 'mock local error' };
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
