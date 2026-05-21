import type { TriggerSet } from './index';

// 国内大模型 CLI 通用兜底关键词（DeepSeek / Qwen / Doubao / GLM 等）
// 限额提示文案具体措辞不一定准确，第一次真实触发时由用户提供原文校正
export const genericZhTriggers: TriggerSet = {
  patterns: [
    /请求过于频繁/,
    /已(达到|超出|超过)使用上限/,
    /配额(已)?用尽/,
    /调用次数已达上限/,
    /(每日|每月|本周|本日)限额/,
    /API\s*调用频率超限/,
    /您已触发限流/,
  ],
  errorContextHints: [
    /错误/,
    /失败/,
    /异常/,
    /\[31m/,
  ],
  resetExtractors: [
    { type: 'compound', pattern: /(\d+)\s*(秒|分钟|分|小时|时)\s*后(?:再|重)?试/ },
    { type: 'compound', pattern: /请\s*(\d+)\s*(秒|分钟|分|小时|时)\s*后再试/ },
    { type: 'absolute', pattern: /(?:将于|于)\s*(\d{1,2}:\d{2})\s*(?:恢复|重置)/ },
  ],
  busyMarkers: [
    /[⠀-⣿]/,
    /\[\?25l/,
  ],
  idleMarkers: [
    /\[\?25h/,
  ],
};
