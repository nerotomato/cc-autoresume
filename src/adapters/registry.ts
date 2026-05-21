import type { Config } from '../config';
import { anthropicAdapter } from './anthropic';
import { mockAdapter } from './mock';
import type { AdapterResult, UsageAdapter } from './types';

const defaultAdapters = [mockAdapter, anthropicAdapter];

// adapter 选不上时的兜底 stub：每次 fetch 都返回 auth 错误。
// 屏幕扫描模式下 adapter 只在触发暂停时做一次可选的 resets_at 兜底调用，
// 失败会走默认等待时间，所以选不上不应该阻止启动。
const fallbackAdapter: UsageAdapter = {
  id: 'fallback',
  kind: 'subscription',
  matches: () => false,
  async fetch(): Promise<AdapterResult> {
    return { error: '无可用的 usage adapter（ANTHROPIC_BASE_URL 非官方端点且未指定 adapter）', authFailed: true };
  },
};

export function selectAdapter(config: Pick<Config, 'adapter' | 'disableApiPoll'>, env: NodeJS.ProcessEnv = process.env, adapters: UsageAdapter[] = defaultAdapters): UsageAdapter {
  if (config.adapter !== 'auto') {
    const adapter = adapters.find((item) => item.id === config.adapter);
    if (!adapter) throw new Error(`找不到 adapter：${config.adapter}`);
    return adapter;
  }

  const matched = adapters.find((adapter) => adapter.id !== 'mock' && adapter.matches(env));
  if (matched) return matched;

  // 屏幕扫描模式下选不到也能跑，降级到 fallback
  if (config.disableApiPoll) return fallbackAdapter;

  throw new Error('无法自动识别 usage adapter，请设置 CC_AUTORESUME_ADAPTER=mock 或 anthropic');
}
