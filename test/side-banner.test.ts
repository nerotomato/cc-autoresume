import { describe, expect, it } from 'vitest';
import { formatAutoWakeBanner, formatBalanceWarning, formatLocalTimeSmart, formatTooLongBanner } from '../src/side-banner';

describe('side-banner', () => {
  it('同日只显示时间', () => {
    const now = new Date(2026, 4, 20, 10, 0, 0);
    const target = new Date(2026, 4, 20, 14, 32, 0).toISOString();

    expect(formatLocalTimeSmart(target, now)).toBe('14:32:00');
  });

  it('跨日显示月日和时间', () => {
    const now = new Date(2026, 4, 20, 23, 50, 0);
    const target = new Date(2026, 4, 21, 0, 30, 0).toISOString();

    expect(formatLocalTimeSmart(target, now)).toBe('5/21 00:30:00');
  });

  it('生成自动唤醒提示', () => {
    const target = new Date(2026, 4, 20, 14, 32, 0).toISOString();

    expect(formatAutoWakeBanner('5h', target)).toContain('5h 已到上限');
  });

  it('生成等不起提示', () => {
    const target = new Date(2026, 4, 27, 14, 32, 0).toISOString();

    expect(formatTooLongBanner('7d', target, 12)).toContain('超过自动唤醒上限 12h');
  });

  it('生成余额预警提示', () => {
    expect(formatBalanceWarning('DeepSeek', 1.23, 5, 'CNY')).toContain('DeepSeek 余额 CNY 1.23 低于阈值 CNY 5');
  });
});
