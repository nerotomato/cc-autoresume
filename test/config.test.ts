import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';

describe('parseConfig', () => {
  it('解析默认值', () => {
    const config = parseConfig([], {});

    expect(config.target).toBe('auto');
    expect(config.threshold).toBe(99);
    expect(config.balanceWarn).toBe(5);
    expect(config.resumeHint).toBe('继续');
    expect(config.adapter).toBe('auto');
    expect(config.disableScreenScan).toBe(false);
    expect(config.rateLimitsPollIntervalMs).toBe(10_000);
    expect(config.rateLimitsMaxStalenessMs).toBe(120_000);
    expect(config.restoreMaxAgeHours).toBe(24);
    expect(config.statePath.endsWith(`.cc-autoresume/state-${process.pid}.json`)).toBe(true);
    expect(config.stateDir.endsWith('.cc-autoresume')).toBe(true);
  });

  it('CC_AUTORESUME_STATE_PATH 可覆盖当前 wrapper 的状态文件路径', () => {
    const config = parseConfig([], { CC_AUTORESUME_STATE_PATH: '/tmp/cc-autoresume-state.json' });

    expect(config.statePath).toBe('/tmp/cc-autoresume-state.json');
  });

  it('CC_AUTORESUME_RESTORE_MAX_AGE_HOURS 可覆盖默认值', () => {
    const config = parseConfig([], { CC_AUTORESUME_RESTORE_MAX_AGE_HOURS: '72' });
    expect(config.restoreMaxAgeHours).toBe(72);
  });

  it('默认开启 session 跟踪、心跳兜底，菜单按键为空', () => {
    const config = parseConfig([], {});
    expect(config.disableSessionTracking).toBe(false);
    expect(config.disableWakeHeartbeat).toBe(false);
    expect(config.limitMenuKeys).toBe('');
  });

  it('CC_AUTORESUME_DISABLE_SESSION_TRACKING=1 关闭 session 跟踪', () => {
    const config = parseConfig([], { CC_AUTORESUME_DISABLE_SESSION_TRACKING: '1' });
    expect(config.disableSessionTracking).toBe(true);
  });

  it('CC_AUTORESUME_DISABLE_WAKE_HEARTBEAT=1 关闭心跳兜底', () => {
    const config = parseConfig([], { CC_AUTORESUME_DISABLE_WAKE_HEARTBEAT: '1' });
    expect(config.disableWakeHeartbeat).toBe(true);
  });

  it('CC_AUTORESUME_LIMIT_MENU_KEYS 配置菜单按键序列', () => {
    const config = parseConfig([], { CC_AUTORESUME_LIMIT_MENU_KEYS: 'up,enter' });
    expect(config.limitMenuKeys).toBe('up,enter');
  });

  it('可配置 rate-limits watcher 轮询间隔和过期时间', () => {
    const config = parseConfig([], {
      CC_AUTORESUME_RATE_LIMITS_POLL_MS: '250',
      CC_AUTORESUME_RATE_LIMITS_MAX_STALENESS_MS: '5000',
    });
    expect(config.rateLimitsPollIntervalMs).toBe(250);
    expect(config.rateLimitsMaxStalenessMs).toBe(5000);
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
      CC_AUTORESUME_BALANCE_WARN: '10',
      CC_AUTORESUME_RESUME_HINT: '继续未完成的任务',
      CC_AUTORESUME_ADAPTER: 'mock',
      CC_AUTORESUME_TEST_MODE: '1',
      CC_AUTORESUME_WAKE_BUFFER_MS: '100',
      CC_AUTORESUME_TARGET_COMMAND: '/bin/zsh',
    });

    expect(config.target).toBe('codex');
    expect(config.threshold).toBe(95);
    expect(config.balanceWarn).toBe(10);
    expect(config.resumeHint).toBe('继续未完成的任务');
    expect(config.adapter).toBe('mock');
    expect(config.wakeBufferMs).toBe(100);
    expect(config.targetCommandOverride).toBe('/bin/zsh');
  });

  it('未知参数自动透传给目标 CLI（不需要 -- 分隔符）', () => {
    const config = parseConfig(['--target=claude', '--allow-dangerously-skip-permissions', '--add-dir', '/tmp'], {});

    expect(config.target).toBe('claude');
    expect(config.targetArgs).toEqual(['--allow-dangerously-skip-permissions', '--add-dir', '/tmp']);
  });

  it('支持位置参数形式指定 ccs target', () => {
    const config = parseConfig(['ccs', 'codex', '--model', 'gpt-5.5'], {});

    expect(config.target).toBe('ccs');
    expect(config.targetArgs).toEqual(['codex', '--model', 'gpt-5.5']);
  });

  it('-- 分隔符仍然有效（用于完全显式透传，含 --target 字面量）', () => {
    const config = parseConfig(['--target=claude', '--', '--target=foo'], {});

    expect(config.target).toBe('claude');
    expect(config.targetArgs).toEqual(['--target=foo']);
  });

  it('--target 后缺少值时抛错', () => {
    expect(() => parseConfig(['--target'], {})).toThrow('--target 需要一个值');
    expect(() => parseConfig(['--target', '--foo'], {})).toThrow('--target 需要一个值');
  });
});
