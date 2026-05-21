import { describe, expect, it } from 'vitest';
import { extractResetTime, findLimitMatch, loadTriggerSet, mergeTriggerSets } from '../../src/triggers';
import { claudeTriggers } from '../../src/triggers/claude';

describe('findLimitMatch', () => {
  it('必须同时有限额关键词和错误上下文标志', () => {
    const text1 = '请求过于频繁'; // 没错误标志
    const text2 = 'Error: rate_limit_error 5-hour limit reached';

    expect(findLimitMatch(text1, claudeTriggers)).toBeUndefined();
    expect(findLimitMatch(text2, claudeTriggers)?.pattern.source).toContain('rate');
  });

  it('只有错误上下文但无限额关键词时不触发', () => {
    expect(findLimitMatch('Error: connection refused', claudeTriggers)).toBeUndefined();
  });
});

describe('extractResetTime', () => {
  const now = Date.parse('2026-05-20T00:00:00.000Z');

  it('解析 retry-after 秒数', () => {
    const ms = extractResetTime('HTTP 429 Retry-After: 1800', claudeTriggers.resetExtractors, now);
    expect(ms).toBe(now + 1800 * 1000);
  });

  it('解析 "try again in N minutes"', () => {
    const ms = extractResetTime('try again in 45 minutes', claudeTriggers.resetExtractors, now);
    expect(ms).toBe(now + 45 * 60 * 1000);
  });

  it('解析 ISO 时间', () => {
    const future = '2026-05-20T03:00:00.000Z';
    const ms = extractResetTime(`resets at ${future}`, claudeTriggers.resetExtractors, now);
    expect(ms).toBe(Date.parse(future));
  });

  it('无匹配返回 undefined', () => {
    expect(extractResetTime('nothing here', claudeTriggers.resetExtractors, now)).toBeUndefined();
  });
});

describe('mergeTriggerSets', () => {
  it('数组字段拼接', () => {
    const a = { patterns: [/a/], errorContextHints: [/h/], resetExtractors: [], busyMarkers: [], idleMarkers: [] };
    const b = { patterns: [/b/, /c/] };
    const merged = mergeTriggerSets(a, b);
    expect(merged.patterns).toHaveLength(3);
  });
});

describe('loadTriggerSet', () => {
  it('claude target 同时包含 claude 和 generic-zh 模式', () => {
    const set = loadTriggerSet('claude');
    const sources = set.patterns.map((p) => p.source);
    expect(sources.some((s) => s.includes('rate'))).toBe(true);
    expect(sources.some((s) => s.includes('请求过于频繁'))).toBe(true);
  });

  it('codex target 同时包含 codex 和 generic-zh 模式', () => {
    const set = loadTriggerSet('codex');
    const sources = set.patterns.map((p) => p.source);
    expect(sources.some((s) => s.includes('quota'))).toBe(true);
    expect(sources.some((s) => s.includes('请求过于频繁'))).toBe(true);
  });
});
