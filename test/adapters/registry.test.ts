import { describe, expect, it } from 'vitest';
import { selectAdapter } from '../../src/adapters/registry';

describe('selectAdapter', () => {
  it('按配置强制选择 mock', () => {
    const adapter = selectAdapter({ adapter: 'mock' }, {});

    expect(adapter.id).toBe('mock');
  });

  it('auto 模式选择 Anthropic 官方 adapter', () => {
    const adapter = selectAdapter({ adapter: 'auto' }, {});

    expect(adapter.id).toBe('anthropic');
  });

  it('非官方 ANTHROPIC_BASE_URL 下 auto 模式报错', () => {
    expect(() => selectAdapter({ adapter: 'auto' }, { ANTHROPIC_BASE_URL: 'https://example.test' })).toThrow('无法自动识别');
  });
});
