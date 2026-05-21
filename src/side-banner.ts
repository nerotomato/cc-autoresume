import type { PauseTrigger, WakeSource } from './state-machine';

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

export function formatVerifyPushed(nextWakeAt: string): string {
  return `[cc-autoresume] 唤醒前校验未通过，再等到 ${formatLocalTimeSmart(nextWakeAt)} 重试`;
}

export function formatScreenPauseBanner(matchedPattern: string, wakeAt: string, source: WakeSource): string {
  const sourceLabel = source === 'text' ? '来自提示文本' : source === 'api' ? '来自 API' : '默认 5h';
  return `[cc-autoresume] 屏幕检测到限额提示（/${matchedPattern}/），将于 ${formatLocalTimeSmart(wakeAt)} 自动唤醒（${sourceLabel}）`;
}

export function formatScreenWakeSkipped(): string {
  return '[cc-autoresume] 唤醒时检测到用户已在使用，跳过自动注入"继续"';
}

export function formatIdlePauseBanner(trigger: PauseTrigger, wakeAt: string): string {
  return `[cc-autoresume] ${formatTrigger(trigger)} 已到上限，将于 ${formatLocalTimeSmart(wakeAt)} 重置（用户当前空闲，重置后不自动注入"继续"）`;
}

export function formatManualPauseBanner(wakeAt?: string): string {
  if (wakeAt) return `[cc-autoresume] 用户手动暂停，需等待至 ${formatLocalTimeSmart(wakeAt)}（不自动唤醒）`;
  return '[cc-autoresume] 用户手动暂停（不自动唤醒）';
}

function formatTrigger(trigger: PauseTrigger): string {
  if (trigger === 'both') return '5h/7d';
  if (trigger === 'screen') return '屏幕限额提示';
  if (trigger === 'manual') return '用户手动';
  return trigger ?? '额度';
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}
