import type { TriggerSet } from './index';

export const claudeTriggers: TriggerSet = {
  patterns: [
    /rate[_ ]limit[_ ]error/i,
    /5[- ]hour limit (reached|exceeded)/i,
    /(weekly|7[- ]day) limit (reached|exceeded)/i,
    /HTTP 429\b/,
    /quota exceeded/i,
    /you have hit (your|the) (5[- ]hour|weekly) limit/i,
    // 真实样例：You've hit your session limit · resets 3:10pm (Asia/Shanghai)
    /you'?ve hit (your|the)\s+(session|usage|5[- ]hour|weekly|daily)\s*limit/i,
  ],
  errorContextHints: [
    /error/i,
    /failed/i,
    /reached/i,
    /exceeded/i,
    /\[31m/,
    /⚠️/,
    // "hit your/the X limit" 这种第一人称自指语气本身就是错误上下文，独立成 hint
    /hit\s+(your|the)\s+\S+\s+limit/i,
  ],
  resetExtractors: [
    { type: 'absolute', pattern: /resets? (?:at|on) ([0-9TZ:.\-+\sapmAPM]+)/ },
    // 真实样例：resets 3:10pm (Asia/Shanghai) —— resets 后直接跟时分，没有 at/on
    { type: 'absolute', pattern: /resets?\s+(\d{1,2}:\d{2}\s*[apmAPM]*)/ },
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
