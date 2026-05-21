import type { TriggerSet } from './index';

export const claudeTriggers: TriggerSet = {
  patterns: [
    /rate[_ ]limit[_ ]error/i,
    /5[- ]hour limit (reached|exceeded)/i,
    /(weekly|7[- ]day) limit (reached|exceeded)/i,
    /HTTP 429\b/,
    /quota exceeded/i,
    /you have hit (your|the) (5[- ]hour|weekly) limit/i,
  ],
  errorContextHints: [
    /error/i,
    /failed/i,
    /reached/i,
    /exceeded/i,
    /\[31m/,
    /⚠️/,
  ],
  resetExtractors: [
    { type: 'absolute', pattern: /resets? (?:at|on) ([0-9TZ:.\-+\sapmAPM]+)/ },
    { type: 'relative', pattern: /retry[- ]after[:\s]+(\d+)/i, unit: 'sec' },
    { type: 'compound', pattern: /try again in (\d+)\s*(minutes?|hours?|seconds?)/i },
    { type: 'compound', pattern: /reset(?:s)? in (\d+)\s*(minutes?|hours?|seconds?)/i },
  ],
  busyMarkers: [
    /[⠀-⣿]/,
    /esc to interrupt/i,
    /✻\s+\w+ing/,
    /●\s+(Running|Reading|Searching|Editing|Writing)/,
    /\[\?25l/,
  ],
  idleMarkers: [
    /^>\s/m,
    /\[\?25h/,
    /shift\+tab/i,
  ],
};
