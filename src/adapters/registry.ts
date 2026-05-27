import type { Config } from '../config';
import { anthropicAdapter } from './anthropic';
import { mockAdapter } from './mock';
import type { AdapterResult, UsageAdapter } from './types';

const defaultAdapters = [mockAdapter, anthropicAdapter];

// adapter 选不上时不阻止 wrapper 启动；唤醒前 verify 会按失败处理并顺延。
const fallbackAdapter: UsageAdapter = {
  id: 'fallback',
  kind: 'subscription',
  matches: () => false,
  async fetch(): Promise<AdapterResult> {
    return { error: '无可用的 usage adapter（ANTHROPIC_BASE_URL 非官方端点且未指定 adapter）', authFailed: true };
  },
};

export function selectAdapter(config: Pick<Config, 'adapter'>, env: NodeJS.ProcessEnv = process.env, adapters: UsageAdapter[] = defaultAdapters): UsageAdapter {
  if (config.adapter !== 'auto') {
    const adapter = adapters.find((item) => item.id === config.adapter);
    if (!adapter) throw new Error(`找不到 adapter：${config.adapter}`);
    return adapter;
  }

  const matched = adapters.find((adapter) => adapter.id !== 'mock' && adapter.matches(env));
  if (matched) return matched;

  return fallbackAdapter;
}
