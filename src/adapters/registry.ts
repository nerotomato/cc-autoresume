import type { Config } from '../config';
import { anthropicAdapter } from './anthropic';
import { mockAdapter } from './mock';
import type { UsageAdapter } from './types';

const defaultAdapters = [mockAdapter, anthropicAdapter];

export function selectAdapter(config: Pick<Config, 'adapter'>, env: NodeJS.ProcessEnv = process.env, adapters: UsageAdapter[] = defaultAdapters): UsageAdapter {
  if (config.adapter !== 'auto') {
    const adapter = adapters.find((item) => item.id === config.adapter);
    if (!adapter) throw new Error(`找不到 adapter：${config.adapter}`);
    return adapter;
  }

  const matched = adapters.find((adapter) => adapter.id !== 'mock' && adapter.matches(env));
  if (matched) return matched;

  throw new Error('无法自动识别 usage adapter，请设置 CC_AUTORESUME_ADAPTER=mock 或 anthropic');
}
