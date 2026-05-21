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

// 从订阅快照里取较晚的 reset 时间。屏幕触发暂停时不知道哪个窗口饱和，
// 取较晚者以避免唤醒后又 verify 失败导致 push 5h 的浪费
export function getLatestKnownResetMs(snapshot: SubscriptionUsageSnapshot): number | undefined {
  const five = parseIsoMs(snapshot.five_hour?.resets_at);
  const seven = parseIsoMs(snapshot.seven_day?.resets_at);
  if (five !== undefined && seven !== undefined) return Math.max(five, seven);
  return five ?? seven;
}

function parseIsoMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}
