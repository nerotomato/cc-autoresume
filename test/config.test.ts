import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';

describe('parseConfig', () => {
  it('解析默认值', () => {
    const config = parseConfig([], {});

    expect(config.target).toBe('auto');
    expect(config.threshold).toBe(99);
    expect(config.maxWaitHours).toBe(12);
    expect(config.balanceWarn).toBe(5);
    expect(config.resumeHint).toBe('继续');
    expect(config.adapter).toBe('auto');
  });

  it('解析 target 和透传参数', () => {
    const config = parseConfig(['--target=claude', '--', '--dangerously-skip-permissions'], {});

    expect(config.target).toBe('claude');
    expect(config.targetArgs).toEqual(['--dangerously-skip-permissions']);
  });

  it('允许环境变量覆盖配置', () => {
    const config = parseConfig([], {
      CC_AUTORESUME_TARGET: 'codex',
      CC_AUTORESUME_THRESHOLD: '95',
      CC_AUTORESUME_MAX_WAIT_HOURS: '6',
      CC_AUTORESUME_BALANCE_WARN: '10',
      CC_AUTORESUME_RESUME_HINT: '继续未完成的任务',
      CC_AUTORESUME_ADAPTER: 'mock',
      CC_AUTORESUME_TEST_MODE: '1',
      CC_AUTORESUME_WAKE_BUFFER_MS: '100',
      CC_AUTORESUME_TARGET_COMMAND: '/bin/zsh',
    });

    expect(config.target).toBe('codex');
    expect(config.threshold).toBe(95);
    expect(config.maxWaitHours).toBe(6);
    expect(config.balanceWarn).toBe(10);
    expect(config.resumeHint).toBe('继续未完成的任务');
    expect(config.adapter).toBe('mock');
    expect(config.wakeBufferMs).toBe(100);
    expect(config.targetCommandOverride).toBe('/bin/zsh');
  });

  it('拒绝未知参数', () => {
    expect(() => parseConfig(['--bad'], {})).toThrow('未知参数');
  });
});
