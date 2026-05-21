import type { Logger } from '../logger';
import { claudeTriggers } from './claude';
import { codexTriggers } from './codex';
import { genericZhTriggers } from './generic-zh';
import { loadUserTriggers } from './user-config';

export type TargetForTriggers = 'claude' | 'codex';

export interface TriggerSet {
  patterns: RegExp[];
  errorContextHints: RegExp[];
  resetExtractors: ResetExtractor[];
  busyMarkers: RegExp[];
  idleMarkers: RegExp[];
}

export type ResetExtractor =
  | { type: 'absolute'; pattern: RegExp }
  | { type: 'relative'; pattern: RegExp; unit: 'sec' | 'min' | 'hour' }
  | { type: 'compound'; pattern: RegExp };

export function loadTriggerSet(target: TargetForTriggers, userConfigPath?: string, logger?: Logger): TriggerSet {
  const base = target === 'codex' ? codexTriggers : claudeTriggers;
  // 通用中文模式对所有 target 都加上，国内代理也可能给 claude 用户返回中文错误
  let merged = mergeTriggerSets(base, genericZhTriggers);

  if (userConfigPath) {
    const user = loadUserTriggers(userConfigPath, logger);
    if (user) merged = mergeTriggerSets(merged, user);
  }

  return merged;
}

export function mergeTriggerSets(a: TriggerSet, b: Partial<TriggerSet>): TriggerSet {
  return {
    patterns: [...a.patterns, ...(b.patterns ?? [])],
    errorContextHints: [...a.errorContextHints, ...(b.errorContextHints ?? [])],
    resetExtractors: [...a.resetExtractors, ...(b.resetExtractors ?? [])],
    busyMarkers: [...a.busyMarkers, ...(b.busyMarkers ?? [])],
    idleMarkers: [...a.idleMarkers, ...(b.idleMarkers ?? [])],
  };
}

export function findLimitMatch(text: string, set: TriggerSet): { pattern: RegExp } | undefined {
  if (!set.errorContextHints.some((hint) => hint.test(text))) return undefined;
  for (const pattern of set.patterns) {
    if (pattern.test(text)) return { pattern };
  }
  return undefined;
}

export function extractResetTime(text: string, extractors: ResetExtractor[], nowMs: number): number | undefined {
  for (const extractor of extractors) {
    const match = extractor.pattern.exec(text);
    if (!match) continue;

    if (extractor.type === 'absolute') {
      const captured = match[1] ?? match[0];
      const parsed = parseAbsoluteTime(captured, nowMs);
      if (parsed !== undefined) return parsed;
      continue;
    }

    if (extractor.type === 'relative') {
      const n = Number.parseFloat(match[1]);
      if (!Number.isFinite(n) || n <= 0) continue;
      return nowMs + n * unitToMs(extractor.unit);
    }

    if (extractor.type === 'compound') {
      const n = Number.parseFloat(match[1]);
      const unit = compoundUnitToMs(match[2]);
      if (!Number.isFinite(n) || n <= 0 || unit === undefined) continue;
      return nowMs + n * unit;
    }
  }
  return undefined;
}

function parseAbsoluteTime(captured: string, nowMs: number): number | undefined {
  const trimmed = captured.trim();
  const isoMs = Date.parse(trimmed);
  if (Number.isFinite(isoMs) && isoMs > nowMs) return isoMs;

  const hhmm = /(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(trimmed);
  if (hhmm) {
    let h = Number.parseInt(hhmm[1], 10);
    const m = Number.parseInt(hhmm[2], 10);
    if (!Number.isFinite(h) || !Number.isFinite(m) || m > 59) return undefined;
    const ampm = hhmm[3]?.toLowerCase();
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    if (h > 23) return undefined;
    const date = new Date(nowMs);
    date.setHours(h, m, 0, 0);
    let targetMs = date.getTime();
    if (targetMs <= nowMs) targetMs += 24 * 60 * 60 * 1000;
    return targetMs;
  }

  return undefined;
}

function unitToMs(unit: 'sec' | 'min' | 'hour'): number {
  if (unit === 'sec') return 1000;
  if (unit === 'min') return 60 * 1000;
  return 60 * 60 * 1000;
}

function compoundUnitToMs(unit: string | undefined): number | undefined {
  if (!unit) return undefined;
  const u = unit.toLowerCase();
  if (u === '秒' || u === 'second' || u === 'seconds' || u === 'sec' || u === 's') return 1000;
  if (u === '分钟' || u === '分' || u === 'minute' || u === 'minutes' || u === 'min' || u === 'm') return 60 * 1000;
  if (u === '小时' || u === '时' || u === 'hour' || u === 'hours' || u === 'h') return 60 * 60 * 1000;
  return undefined;
}
