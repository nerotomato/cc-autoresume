import { describe, expect, it, vi } from 'vitest';
import { createScreenScanner, type ScreenScanResult } from '../src/screen-scanner';
import { loadTriggerSet } from '../src/triggers';

function makeScanner(now: () => number, onLimitHit: (r: ScreenScanResult) => void = () => {}) {
  return createScreenScanner({
    triggerSet: loadTriggerSet('claude'),
    onLimitHit,
    now,
    busyDebounceMs: 2000,
    rateLimitDebounceMs: 300,
    bufferSize: 4096,
  });
}

describe('ScreenScanner.feed', () => {
  it('识别带错误上下文的限额提示', () => {
    const hits: ScreenScanResult[] = [];
    const scanner = makeScanner(() => 0, (r) => hits.push(r));

    scanner.feed('Error: rate_limit_error 5-hour limit reached\n');

    expect(hits).toHaveLength(1);
    expect(hits[0].trigger).toBe('screen');
  });

  it('限额关键词但无错误上下文时不触发（防误识别）', () => {
    const hits: ScreenScanResult[] = [];
    const scanner = makeScanner(() => 0, (r) => hits.push(r));

    // Claude 在回答用户问题时可能解释 rate limit 概念，没有错误标志
    scanner.feed('Sure, let me explain rate limits. A rate limit is...');

    expect(hits).toHaveLength(0);
  });

  it('能匹配跨 chunk 边界的文本', () => {
    const hits: ScreenScanResult[] = [];
    const scanner = makeScanner(() => 0, (r) => hits.push(r));

    scanner.feed('Error: rate_lim');
    scanner.feed('it_error reached\n');

    expect(hits).toHaveLength(1);
  });

  it('debounce 防止同一错误重复触发', () => {
    const hits: ScreenScanResult[] = [];
    let t = 0;
    const scanner = makeScanner(() => t, (r) => hits.push(r));

    scanner.feed('Error: rate_limit_error\n');
    t += 100; // 在 300ms debounce 内
    scanner.feed('Error: rate_limit_error again\n');

    expect(hits).toHaveLength(1);
  });

  it('pause 后停止扫描', () => {
    const hits: ScreenScanResult[] = [];
    const scanner = makeScanner(() => 0, (r) => hits.push(r));

    scanner.pause();
    scanner.feed('Error: rate_limit_error\n');

    expect(hits).toHaveLength(0);
  });

  it('从 retry-after 抽取 reset 时间', () => {
    const hits: ScreenScanResult[] = [];
    const t = 1_000_000;
    const scanner = makeScanner(() => t, (r) => hits.push(r));

    scanner.feed('Error: rate_limit_error HTTP 429 Retry-After: 600\n');

    expect(hits[0].extractedResetMs).toBe(t + 600 * 1000);
  });
});

describe('ScreenScanner.busyState', () => {
  it('收到 busy marker 后状态变为 BUSY', () => {
    let t = 1_000_000;
    const scanner = makeScanner(() => t);

    scanner.feed('⠋ Reading file...');

    expect(scanner.getBusyState().state).toBe('BUSY');
  });

  it('busy 状态在 debounce 时间后衰减为 IDLE', () => {
    let t = 1_000_000;
    const scanner = makeScanner(() => t);

    scanner.feed('⠋ Reading file...');
    expect(scanner.getBusyState().state).toBe('BUSY');

    t += 2500; // 超过 2000ms debounce
    expect(scanner.getBusyState().state).toBe('IDLE');
  });

  it('idle marker 立即切回 IDLE', () => {
    let t = 1_000_000;
    const scanner = makeScanner(() => t);

    scanner.feed('⠋ Reading...');
    expect(scanner.getBusyState().state).toBe('BUSY');

    scanner.feed('\x1b[?25h'); // cursor show
    expect(scanner.getBusyState().state).toBe('IDLE');
  });

  it('记录最后一次 BUSY 的时间戳', () => {
    let t = 1_000_000;
    const scanner = makeScanner(() => t);

    scanner.feed('⠋');
    expect(scanner.getBusyState().lastBusyAt).toBe(t);
  });
});

describe('ScreenScanner.reset', () => {
  it('reset 清空 buffer 和 debounce 计数器', () => {
    const hits: ScreenScanResult[] = [];
    let t = 0;
    const scanner = makeScanner(() => t, (r) => hits.push(r));

    scanner.feed('Error: rate_limit_error\n');
    expect(hits).toHaveLength(1);

    scanner.reset();
    t += 100; // 仍在 debounce 内但已 reset
    scanner.feed('Error: rate_limit_error\n');
    expect(hits).toHaveLength(2);
  });
});

// 为了让 vitest 不抱怨 vi 没用到
vi;
