import type { PauseTrigger } from './state-machine';

export function formatLocalTimeSmart(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameDay) return time;
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

export function formatAutoWakeBanner(trigger: PauseTrigger, wakeAt: string): string {
  return `[cc-autoresume] ${formatTrigger(trigger)} 已到上限，将于 ${formatLocalTimeSmart(wakeAt)} 自动唤醒`;
}

export function formatTooLongBanner(trigger: PauseTrigger, wakeAt: string, maxWaitHours: number): string {
  return `[cc-autoresume] ${formatTrigger(trigger)} 已到上限，需等待至 ${formatLocalTimeSmart(wakeAt)}，超过自动唤醒上限 ${maxWaitHours}h。wrapper 将保持挂起，按 Ctrl+C 退出。`;
}

export function formatBalanceWarning(provider: string, balance: number, threshold: number, currency?: string): string {
  const unit = currency ? `${currency} ` : '';
  return `[cc-autoresume] ${provider} 余额 ${unit}${balance} 低于阈值 ${unit}${threshold}，请尽快充值`;
}

export function formatVerifyFailed(attempt: number, maxAttempts: number): string {
  return `[cc-autoresume] 唤醒前校验未通过，${attempt}/${maxAttempts} 次重试`;
}

function formatTrigger(trigger: PauseTrigger): string {
  if (trigger === 'both') return '5h/7d';
  if (trigger === 'screen') return '屏幕限额提示';
  return trigger ?? '额度';
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}
