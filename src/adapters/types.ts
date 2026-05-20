export interface UsageWindow {
  utilization: number;
  resets_at?: string;
}

export interface SubscriptionUsageSnapshot {
  kind: 'subscription';
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  fetched_at: number;
}

export interface BalanceUsageSnapshot {
  kind: 'balance';
  provider: string;
  balance: number;
  currency?: string;
  fetched_at: number;
}

export type UsageSnapshot = SubscriptionUsageSnapshot | BalanceUsageSnapshot;

export interface AdapterError {
  error: string;
  status?: number;
  authFailed?: boolean;
  transient?: boolean;
}

export type AdapterResult = UsageSnapshot | AdapterError;

export interface UsageAdapter {
  id: string;
  kind: 'subscription' | 'balance' | 'mock';
  matches(env: NodeJS.ProcessEnv): boolean;
  fetch(env: NodeJS.ProcessEnv): Promise<AdapterResult>;
}

export function isAdapterError(value: AdapterResult): value is AdapterError {
  return 'error' in value;
}

export function isSubscriptionSnapshot(value: AdapterResult): value is SubscriptionUsageSnapshot {
  return !isAdapterError(value) && value.kind === 'subscription';
}

export function isBalanceSnapshot(value: AdapterResult): value is BalanceUsageSnapshot {
  return !isAdapterError(value) && value.kind === 'balance';
}
