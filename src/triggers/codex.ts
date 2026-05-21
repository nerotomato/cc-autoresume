import type { TriggerSet } from './index';

export const codexTriggers: TriggerSet = {
  patterns: [
    /you exceeded your current quota/i,
    /rate_limit_exceeded/i,
    /HTTP 429\b/,
    /tokens per (minute|day) limit/i,
    /requests per (minute|day) limit/i,
  ],
  errorContextHints: [
    /error/i,
    /failed/i,
    /exceeded/i,
    /\[31m/,
  ],
  resetExtractors: [
    { type: 'relative', pattern: /retry[- ]after[:\s]+(\d+)/i, unit: 'sec' },
    { type: 'compound', pattern: /please try again in (\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?)/i },
  ],
  busyMarkers: [
    /[⠀-⣿]/,
    /\[\?25l/,
  ],
  idleMarkers: [
    /\[\?25h/,
  ],
};
