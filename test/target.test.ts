import { describe, expect, it } from 'vitest';
import { resolveTarget } from '../src/target';

describe('resolveTarget', () => {
  it('test mode 下支持 ccs target override', () => {
    const target = resolveTarget({
      target: 'ccs',
      targetArgs: ['codex'],
      targetCommandOverride: '/tmp/fake-ccs',
    });

    expect(target).toEqual({
      name: 'ccs',
      command: '/tmp/fake-ccs',
      args: ['codex'],
    });
  });
});
