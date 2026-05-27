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
    recentBusyMs: 10_000,
  });
}

/** 模拟 CLI 正在处理中（先发一个 spinner 字符让状态进入 BUSY） */
function setBusy(scanner: ReturnType<typeof makeScanner>): void {
  scanner.feed('⠋');
}

describe('ScreenScanner.feed', () => {
  it('BUSY 状态下识别带错误上下文的限额提示', () => {
    const hits: ScreenScanResult[] = [];
    const scanner = makeScanner(() => 0, (r) => hits.push(r));

    setBusy(scanner);
    scanner.feed('Error: rate_limit_error 5-hour limit reached\n');

    expect(hits).toHaveLength(1);
    expect(hits[0].trigger).toBe('screen');
  });

  it('IDLE 状态下粘贴错误文本不触发（防用户输入误触发）', () => {
    const hits: ScreenScanResult[] = [];
    let t = 100_000;
    const scanner = makeScanner(() => t, (r) => hits.push(r));

    // 模拟 CLI 处于 IDLE（提示符），lastBusyAt 从未设置
    scanner.feed('> ');
    t += 5000;
    scanner.feed('API Error: Request rejected (429) · You have exceeded the 5-hour usage quota.\n');

    expect(hits).toHaveLength(0);
  });

  it('IDLE 但最近刚从 BUSY 切换过来时仍然触发（错误和 idle marker 在同一批输出）', () => {
    const hits: ScreenScanResult[] = [];
    let t = 100_000;
    const scanner = makeScanner(() => t, (r) => hits.push(r));

    setBusy(scanner);
    t += 500; // 500ms 后错误出现，同时带有 idle marker
    scanner.feed('Error: rate_limit_error 5-hour limit reached\n> ');

    expect(hits).toHaveLength(1);
  });

  it('限额关键词但无错误上下文时不触发（防误识别）', () => {
    const hits: ScreenScanResult[] = [];
    const scanner = makeScanner(() => 0, (r) => hits.push(r));

    setBusy(scanner);
    scanner.feed('Sure, let me explain rate limits. A rate limit is...');

    expect(hits).toHaveLength(0);
  });

  it('能匹配跨 chunk 边界的文本', () => {
    const hits: ScreenScanResult[] = [];
    const scanner = makeScanner(() => 0, (r) => hits.push(r));

    setBusy(scanner);
    scanner.feed('Error: rate_lim');
    scanner.feed('it_error reached\n');

    expect(hits).toHaveLength(1);
  });

  it('debounce 防止同一错误重复触发', () => {
    const hits: ScreenScanResult[] = [];
    let t = 0;
    const scanner = makeScanner(() => t, (r) => hits.push(r));

    setBusy(scanner);
    scanner.feed('Error: rate_limit_error\n');
    t += 100; // 在 300ms debounce 内
    scanner.feed('Error: rate_limit_error again\n');

    expect(hits).toHaveLength(1);
  });

  it('pause 后停止扫描', () => {
    const hits: ScreenScanResult[] = [];
    const scanner = makeScanner(() => 0, (r) => hits.push(r));

    scanner.pause();
    setBusy(scanner); // pause 时 feed 被跳过
    scanner.feed('Error: rate_limit_error\n');

    expect(hits).toHaveLength(0);
  });

  it('从 retry-after 抽取 reset 时间', () => {
    const hits: ScreenScanResult[] = [];
    const t = 1_000_000;
    const scanner = makeScanner(() => t, (r) => hits.push(r));

    setBusy(scanner);
    scanner.feed('Error: rate_limit_error HTTP 429 Retry-After: 600\n');

    expect(hits[0].extractedResetMs).toBe(t + 600 * 1000);
  });

  it('识别 "Request rejected (429) exceeded usage quota" 格式', () => {
    const hits: ScreenScanResult[] = [];
    const t = new Date('2026-05-27T12:00:00+08:00').getTime();
    const scanner = makeScanner(() => t, (r) => hits.push(r));

    setBusy(scanner);
    scanner.feed(
      'API Error: Request rejected (429) · You have exceeded the 5-hour usage quota. ' +
      'It will reset at 2026-05-27 20:46:00 +0800 CST.\n',
    );

    expect(hits).toHaveLength(1);
    expect(hits[0].trigger).toBe('screen');
    expect(hits[0].extractedResetMs).toBeDefined();
    const resetDate = new Date(hits[0].extractedResetMs!);
    expect(resetDate.getUTCHours()).toBe(12); // 20:46 +0800 = 12:46 UTC
    expect(resetDate.getUTCMinutes()).toBe(46);
  });

  it('BUSY 超过 recentBusyMs 后进入 IDLE 不触发', () => {
    const hits: ScreenScanResult[] = [];
    let t = 100_000;
    const scanner = makeScanner(() => t, (r) => hits.push(r));

    setBusy(scanner);
    t += 15_000; // 超过 recentBusyMs (10s)，转为 IDLE
    scanner.feed('> ');
    t += 1000;
    scanner.feed('Error: rate_limit_error 5-hour limit reached\n');

    expect(hits).toHaveLength(0);
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

    setBusy(scanner);
    scanner.feed('Error: rate_limit_error\n');
    expect(hits).toHaveLength(1);

    scanner.reset();
    t += 100; // 仍在 debounce 内但已 reset
    setBusy(scanner);
    scanner.feed('Error: rate_limit_error\n');
    expect(hits).toHaveLength(2);
  });
});

// 为了让 vitest 不抱怨 vi 没用到
vi;
