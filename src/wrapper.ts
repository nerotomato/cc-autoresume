import * as pty from 'node-pty';
import type { Config } from './config';
import type { Logger } from './logger';
import { Scheduler, type SchedulerEvent } from './scheduler';
import {
  formatAutoWakeBanner,
  formatBalanceWarning,
  formatIdlePauseBanner,
  formatScreenPauseBanner,
  formatScreenWakeSkipped,
  formatTooLongBanner,
  formatVerifyPushed,
} from './side-banner';
import { sweepStaleStates, type PersistedState, type StateStore } from './state-store';
import { classifyPause, decideScreenWakeAt } from './state-machine';
import { createScreenScanner, type ScreenScanResult, type ScreenScanner } from './screen-scanner';
import { loadTriggerSet } from './triggers';
import type { TargetCommand } from './target';
import { parseKeySequenceSteps, sendKeySequence, sendWakeSequence } from './wake-keys';
import { decideSession } from './session-id';
import { getLatestKnownResetMs, isSubscriptionSnapshot, type UsageAdapter } from './adapters/types';

const RECENT_BUSY_WINDOW_MS = 5000;

export interface WrapperOptions {
  config: Config;
  target: TargetCommand;
  adapter: UsageAdapter;
  stateStore: StateStore;
  logger: Logger;
}

export async function runWrapper(options: WrapperOptions): Promise<number> {
  const { config, target, adapter, stateStore, logger } = options;

  // Phase 4: 启动时清扫一遍——把"PID 死了 + paused_at 超过 max_age" 的 state 文件直接删，目录卫生
  const maxAgeMs = config.restoreMaxAgeHours * 60 * 60 * 1000;
  const sweptPaths = await sweepStaleStates(config.stateDir, maxAgeMs);
  if (sweptPaths.length > 0) {
    await logger.log('state_swept', { count: sweptPaths.length, paths: sweptPaths });
  }

  // 仅 claude target 启用 session 跟踪：spawn 前算出 UUID + 注入参数
  let sessionId: string | undefined;
  let spawnArgs = target.args;
  if (target.name === 'claude' && !config.disableSessionTracking) {
    const decision = decideSession({ args: target.args });
    sessionId = decision.sessionId;
    spawnArgs = decision.injectedArgs;
    await logger.log('session_decided', { source: decision.source, sessionId });
  }

  const child = pty.spawn(target.command, spawnArgs, {
    name: process.env.TERM || 'xterm-256color',
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    cwd: process.cwd(),
    env: process.env,
  });

  await logger.log('wrapper_start', {
    target: target.name,
    command: target.command,
    pid: child.pid,
    adapter: adapter.id,
    sessionId,
  });

  let context!: SchedulerContext;

  const scanner = config.disableScreenScan
    ? undefined
    : createScreenScanner({
        triggerSet: loadTriggerSet(target.name, config.triggersFile, logger),
        onLimitHit: (result) => {
          void handleScreenLimitHit(result, context);
        },
      });

  const scheduler = new Scheduler({
    adapter,
    env: process.env,
    threshold: config.threshold,
    maxWaitHours: config.maxWaitHours,
    balanceWarn: config.balanceWarn,
    wakeBufferMs: config.wakeBufferMs,
    defaultWaitMs: config.defaultWaitHours * 60 * 60 * 1000,
    disablePolling: config.disableApiPoll,
    onEvent: async (event) => {
      await handleSchedulerEvent(event, context);
    },
  });

  context = {
    config, target, adapter, stateStore, logger, child, scheduler, scanner,
    paused: false,
    sessionId,
  };

  return new Promise((resolve) => {
    let finished = false;
    let lastCtrlC = 0;
    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;

    const cleanup = (exitCode: number) => {
      if (finished) return;
      finished = true;
      scheduler.stop();
      stdin.off('data', onInput);
      stdout.off('resize', onResize);
      process.off('SIGTERM', onSigterm);
      process.off('SIGINT', onSigint);
      if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      void logger.log('wrapper_exit', { exitCode, pid: child.pid });
      resolve(exitCode);
    };

    const forceExit = () => {
      try {
        child.kill('SIGTERM');
      } catch {
      }
      cleanup(130);
    };

    function onInput(data: Buffer): void {
      if (data.includes(3)) {
        const now = Date.now();
        if (now - lastCtrlC <= 300) {
          forceExit();
          return;
        }
        lastCtrlC = now;
      }
      child.write(data.toString('utf8'));
    }

    function onResize(): void {
      child.resize(stdout.columns || 80, stdout.rows || 24);
    }

    function onSigterm(): void {
      child.kill('SIGTERM');
    }

    function onSigint(): void {
      child.write('\x03');
    }

    child.onData((data) => {
      stdout.write(data);
      scanner?.feed(data);
    });

    child.onExit(({ exitCode }) => {
      cleanup(exitCode ?? 0);
    });

    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onInput);
    stdout.on('resize', onResize);
    process.on('SIGTERM', onSigterm);
    process.on('SIGINT', onSigint);

    scheduler.start();
  });
}

interface SchedulerContext {
  config: Config;
  target: TargetCommand;
  adapter: UsageAdapter;
  stateStore: StateStore;
  logger: Logger;
  child: pty.IPty;
  scheduler: Scheduler;
  scanner?: ScreenScanner;
  paused: boolean;
  sessionId?: string;
}

function isBusyOrRecentlyBusy(scanner: ScreenScanner | undefined): boolean {
  if (!scanner) return true; // 没扫描器无法判断，保守认定 BUSY → 倾向自动恢复
  const busy = scanner.getBusyState();
  if (busy.state === 'BUSY') return true;
  return Date.now() - busy.lastBusyAt <= RECENT_BUSY_WINDOW_MS;
}

async function handleScreenLimitHit(result: ScreenScanResult, context: SchedulerContext): Promise<void> {
  const { config, target, adapter, stateStore, logger, child, scheduler, scanner } = context;
  if (context.paused) return;
  context.paused = true;
  scanner?.pause();

  // 屏幕触发时若 API 可用，调一次拿 reset 时间作兜底
  let apiResetMs: number | undefined;
  if (!config.disableApiPoll) {
    try {
      const snap = await adapter.fetch(process.env);
      if (isSubscriptionSnapshot(snap)) apiResetMs = getLatestKnownResetMs(snap);
    } catch {
      // 忽略，走默认 5h 兜底
    }
  }

  const defaultWaitMs = config.defaultWaitHours * 60 * 60 * 1000;
  const nowMs = Date.now();
  const decision = decideScreenWakeAt(result.extractedResetMs, apiResetMs, defaultWaitMs, nowMs, config.wakeBufferMs);
  const wakeAt = new Date(decision.wakeAtMs).toISOString();
  const mode = classifyPause(decision.wakeAtMs, nowMs, config.maxWaitHours);

  const state: PersistedState = {
    version: 2,
    state: mode,
    trigger: 'screen',
    target: target.name,
    adapter_id: adapter.id,
    paused_at: new Date().toISOString(),
    wake_at: wakeAt,
    pid: child.pid,
    auto_resume: true,
    wake_source: decision.source,
    session_id: context.sessionId,
  };
  await stateStore.save(state);
  printBanner(formatScreenPauseBanner(result.matchedPattern, wakeAt, decision.source));
  await logger.log('screen_pause_due', { matched: result.matchedPattern, wakeAt, source: decision.source, mode, sessionId: context.sessionId });

  // 撞墙时如果用户配置了菜单按键序列，盲发让 claude 自动选"暂停等待"
  // 等 500ms 让 claude 把菜单画完，再发键
  if (target.name === 'claude' && config.limitMenuKeys && config.limitMenuKeys.length > 0) {
    const steps = parseKeySequenceSteps(config.limitMenuKeys);
    if (steps.length > 0) {
      setTimeout(() => {
        void sendKeySequence(child, steps).then(() => logger.log('menu_keys_sent', { keys: config.limitMenuKeys }));
      }, 500);
    }
  }

  if (mode === 'paused') scheduler.pauseUntil(wakeAt, { skipVerify: true });
}

async function handleSchedulerEvent(event: SchedulerEvent, context: SchedulerContext): Promise<void> {
  const { config, target, adapter, stateStore, logger, child, scheduler, scanner } = context;

  if (event.type === 'snapshot') {
    await logger.log('snapshot', { kind: event.snapshot.kind, adapter: adapter.id });
    return;
  }

  if (event.type === 'balance-warning') {
    printBanner(formatBalanceWarning(event.snapshot.provider, event.snapshot.balance, config.balanceWarn, event.snapshot.currency));
    await logger.log('balance_warning', { provider: event.snapshot.provider, balance: event.snapshot.balance, currency: event.snapshot.currency });
    return;
  }

  if (event.type === 'pause-due') {
    if (context.paused) return;
    context.paused = true;
    scanner?.pause();

    const autoResume = isBusyOrRecentlyBusy(scanner);
    const state: PersistedState = {
      version: 2,
      state: event.mode,
      trigger: event.trigger,
      target: target.name,
      adapter_id: adapter.id,
      paused_at: new Date().toISOString(),
      resets_at: event.resetsAt,
      wake_at: event.wakeAt,
      pid: child.pid,
      auto_resume: autoResume,
      wake_source: 'api',
      session_id: context.sessionId,
    };
    await stateStore.save(state);

    const banner = !autoResume
      ? formatIdlePauseBanner(event.trigger, event.wakeAt)
      : event.mode === 'paused'
        ? formatAutoWakeBanner(event.trigger, event.wakeAt)
        : formatTooLongBanner(event.trigger, event.wakeAt, config.maxWaitHours);
    printBanner(banner);
    await logger.log('pause_due', { mode: event.mode, trigger: event.trigger, wakeAt: event.wakeAt, auto_resume: autoResume });
    return;
  }

  if (event.type === 'wake-due') {
    const persisted = await stateStore.load();

    // 用户在暂停期间已经自己回来用了，跳过注入避免污染上下文
    if (scanner && scanner.getBusyState().state === 'BUSY') {
      printBanner(formatScreenWakeSkipped());
      await stateStore.clear();
      context.paused = false;
      scanner.resume();
      await logger.log('wake_skipped_user_active', { target: target.name });
      scheduler.resumePolling();
      return;
    }

    // 之前的暂停被标为不自动恢复（IDLE 时被 API 路径暂停，或预留的 manual）
    if (persisted && persisted.auto_resume === false) {
      await stateStore.clear();
      context.paused = false;
      scanner?.resume();
      await logger.log('wake_skipped_no_resume', { target: target.name });
      scheduler.resumePolling();
      return;
    }

    await stateStore.save({
      version: 2,
      state: 'waking',
      trigger: null,
      target: target.name,
      adapter_id: adapter.id,
      wake_at: new Date().toISOString(),
      pid: child.pid,
      auto_resume: true,
      session_id: context.sessionId,
    });
    await sendWakeSequence(child, { target: target.name, resumeHint: config.resumeHint });
    await stateStore.clear();
    context.paused = false;
    scanner?.resume();
    await logger.log('wake_sent', { target: target.name });
    scheduler.resumePolling();
    return;
  }

  if (event.type === 'verify-pushed') {
    printBanner(formatVerifyPushed(event.nextWakeAt));
    const current = await stateStore.load();
    if (current) {
      await stateStore.save({ ...current, wake_at: event.nextWakeAt });
    }
    await logger.log('verify_pushed', { attempt: event.attempt, nextWakeAt: event.nextWakeAt, error: event.error });
    return;
  }

  if (event.type === 'error') {
    await logger.log('scheduler_error', { error: event.error });
  }
}

function printBanner(message: string): void {
  process.stderr.write(`\r\n${message}\r\n`);
}
