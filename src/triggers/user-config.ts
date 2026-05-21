import fs from 'node:fs';
import type { Logger } from '../logger';
import type { ResetExtractor, TriggerSet } from './index';

interface RawTriggerSet {
  patterns?: string[];
  errorContextHints?: string[];
  resetExtractors?: RawResetExtractor[];
  busyMarkers?: string[];
  idleMarkers?: string[];
}

type RawResetExtractor =
  | { type: 'absolute'; pattern: string }
  | { type: 'relative'; pattern: string; unit: 'sec' | 'min' | 'hour' }
  | { type: 'compound'; pattern: string };

export function loadUserTriggers(filePath: string, logger?: Logger): Partial<TriggerSet> | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    // 文件不存在是常态，不报错；其他错误只 warn
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      void logger?.log('triggers_read_failed', { path: filePath, error: messageOf(error) });
    }
    return undefined;
  }

  let parsed: RawTriggerSet;
  try {
    parsed = JSON.parse(raw) as RawTriggerSet;
  } catch (error) {
    void logger?.log('triggers_parse_failed', { path: filePath, error: messageOf(error) });
    return undefined;
  }

  return {
    patterns: toRegexArray(parsed.patterns, logger, 'patterns'),
    errorContextHints: toRegexArray(parsed.errorContextHints, logger, 'errorContextHints'),
    resetExtractors: toResetExtractors(parsed.resetExtractors, logger),
    busyMarkers: toRegexArray(parsed.busyMarkers, logger, 'busyMarkers'),
    idleMarkers: toRegexArray(parsed.idleMarkers, logger, 'idleMarkers'),
  };
}

function toRegexArray(values: string[] | undefined, logger: Logger | undefined, field: string): RegExp[] {
  if (!values) return [];
  const result: RegExp[] = [];
  for (const value of values) {
    try {
      result.push(new RegExp(value));
    } catch (error) {
      void logger?.log('triggers_invalid_regex', { field, value, error: messageOf(error) });
    }
  }
  return result;
}

function toResetExtractors(values: RawResetExtractor[] | undefined, logger: Logger | undefined): ResetExtractor[] {
  if (!values) return [];
  const result: ResetExtractor[] = [];
  for (const raw of values) {
    try {
      const pattern = new RegExp(raw.pattern);
      if (raw.type === 'relative') {
        if (!['sec', 'min', 'hour'].includes(raw.unit)) throw new Error(`invalid unit: ${raw.unit}`);
        result.push({ type: 'relative', pattern, unit: raw.unit });
      } else if (raw.type === 'absolute') {
        result.push({ type: 'absolute', pattern });
      } else if (raw.type === 'compound') {
        result.push({ type: 'compound', pattern });
      } else {
        throw new Error(`unknown type: ${(raw as { type?: string }).type}`);
      }
    } catch (error) {
      void logger?.log('triggers_invalid_extractor', { raw, error: messageOf(error) });
    }
  }
  return result;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
