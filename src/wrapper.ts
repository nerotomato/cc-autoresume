import * as pty from 'node-pty';
import type { Config } from './config';
import type { Logger } from './logger';
import { Scheduler, type SchedulerEvent } from './scheduler';
import {
  formatAutoWakeBanner,
  formatScreenPauseBanner,
  formatScreenWakeSkipped,
  formatVerifyPushed,
} from './side-banner';
import { isProcessAlive, sweepStaleStates, type PersistedState, type StateStore } from './state-store';
import { decideScreenWakeAt, type WakeDecision } from './state-machine';
import { createScreenScanner, type ScreenScanResult, type ScreenScanner } from './screen-scanner';
import { loadTriggerSet } from './triggers';
import type { TargetCommand } from './target';
import { parseKeySequenceSteps, sendKeySequence, sendWakeSequence } from './wake-keys';
import { RateLimitsWatcher } from './rate-limits-watcher';
import {
  clearStatusLineHint,
  createStatusLineSpy,
  sweepStaleStatusLineFiles,
  writeStatusLineHint,
  type StatusLineSpySetup,
} from './statusline-spy';
import { decideSession } from './session-id';
import type { SubscriptionUsageSnapshot, UsageAdapter } from './adapters/types';


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
  const sweptRuntimePaths = await sweepStaleStatusLineFiles(config.stateDir, isProcessAlive);
  const sweptAllPaths = [...sweptPaths, ...sweptRuntimePaths];
  if (sweptAllPaths.length > 0) {
    await logger.log('state_swept', { count: sweptAllPaths.length, paths: sweptAllPaths });
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

  const spySetup = shouldInjectStatusLineSpy(target)
    ? await createStatusLineSpy({ stateDir: config.stateDir })
    : undefined;
  const targetEnv = spySetup
    ? {
        ...process.env,
        CC_AUTORESUME_ORIGINAL_STATUSLINE: spySetup.originalStatusLineCommand ?? '',
        CC_AUTORESUME_RATE_LIMITS_FILE: spySetup.rateLimitsFilePath,
        CC_AUTORESUME_STATUSLINE_HINT_FILE: spySetup.statusLineHintFilePath,
      }
    : process.env;
  if (spySetup) {
    spawnArgs = injectSettingsArgs(target, spawnArgs, spySetup.settingsOverride);
  }

  const child = pty.spawn(target.command, spawnArgs, {
    name: process.env.TERM || 'xterm-256color',
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    cwd: process.cwd(),
    env: targetEnv,
  });

  await logger.log('wrapper_start', {
    target: target.name,
    command: target.command,
    pid: child.pid,
    adapter: adapter.id,
    sessionId,
    statusLineSpy: Boolean(spySetup),
    spyScriptPath: spySetup?.spyScriptPath,
    rateLimitsFilePath: spySetup?.rateLimitsFilePath,
    statusLineHintFilePath: spySetup?.statusLineHintFilePath,
  });

  let context!: SchedulerContext;

  const scanner = config.disableScreenScan
    ? undefined
    : createScreenScanner({
        triggerSet: loadTriggerSet(triggerTargetFor(target), config.triggersFile, logger),
        onLimitHit: (result) => {
          void handleScreenLimitHit(result, context);
        },
      });

  const scheduler = new Scheduler({
    adapter,
    env: process.env,
    threshold: config.threshold,
    defaultWaitMs: config.defaultWaitHours * 60 * 60 * 1000,
    disableWakeHeartbeat: config.disableWakeHeartbeat,
    onEvent: async (event) => {
      await handleSchedulerEvent(event, context);
    },
  });

  const rateLimitsWatcher = spySetup && shouldWatchStatusLineRateLimits(target, process.env)
    ? new RateLimitsWatcher({
        filePath: spySetup.rateLimitsFilePath,
        threshold: config.threshold,
        pollIntervalMs: config.rateLimitsPollIntervalMs,
        maxStalenessMs: config.rateLimitsMaxStalenessMs,
        wakeBufferMs: config.wakeBufferMs,
        onLimitHit: async (decision, snapshot) => {
          await handleStatusLineLimitHit(decision, snapshot, context);
        },
        onError: async (error) => {
          await logger.log('rate_limits_watcher_error', { error });
        },
      })
    : undefined;

  context = {
    config, target, adapter, stateStore, logger, child, scheduler, scanner, spySetup, rateLimitsWatcher,
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
      rateLimitsWatcher?.stop();
      stdin.off('data', onInput);
      stdout.off('resize', onResize);
      process.off('SIGTERM', onSigterm);
      process.off('SIGINT', onSigint);
      if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      void (async () => {
        await clearStatusLineHint(spySetup?.statusLineHintFilePath);
        await spySetup?.cleanup();
        await logger.log('wrapper_exit', { exitCode, pid: child.pid });
      })().finally(() => resolve(exitCode));
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
    rateLimitsWatcher?.start();
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
  spySetup?: StatusLineSpySetup;
  rateLimitsWatcher?: RateLimitsWatcher;
  paused: boolean;
  sessionId?: string;
}

async function handleStatusLineLimitHit(
  decision: WakeDecision,
  _snapshot: SubscriptionUsageSnapshot,
  context: SchedulerContext,
): Promise<void> {
  const { config, target, adapter, stateStore, logger, child, scheduler, scanner, spySetup } = context;
  if (context.paused) return;
  context.paused = true;
  scanner?.pause();

  const wakeAt = new Date(decision.wakeAtMs).toISOString();
  const state: PersistedState = {
    version: 2,
    state: 'paused',
    trigger: decision.trigger,
    target: target.name,
    adapter_id: adapter.id,
    paused_at: new Date().toISOString(),
    resets_at: decision.resetsAt,
    wake_at: wakeAt,
    pid: child.pid,
    auto_resume: true,
    wake_source: 'statusline',
    session_id: context.sessionId,
  };
  await stateStore.save(state);

  if (spySetup) await writeStatusLineHint(spySetup.statusLineHintFilePath, wakeAt, decision.trigger);
  printBanner(formatAutoWakeBanner(decision.trigger, wakeAt));
  await logger.log('statusline_pause_due', { trigger: decision.trigger, wakeAt, sessionId: context.sessionId });

  scheduler.pauseUntil(wakeAt, { skipVerify: true });
}

async function handleScreenLimitHit(result: ScreenScanResult, context: SchedulerContext): Promise<void> {
  const { config, target, adapter, stateStore, logger, child, scheduler, scanner, spySetup } = context;
  if (context.paused) return;
  context.paused = true;
  scanner?.pause();

  const defaultWaitMs = config.defaultWaitHours * 60 * 60 * 1000;
  const nowMs = Date.now();
  const decision = decideScreenWakeAt(result.extractedResetMs, undefined, defaultWaitMs, nowMs, config.wakeBufferMs);
  const wakeAt = new Date(decision.wakeAtMs).toISOString();

  const state: PersistedState = {
    version: 2,
    state: 'paused',
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
  if (spySetup) await writeStatusLineHint(spySetup.statusLineHintFilePath, wakeAt, 'screen');
  printBanner(formatScreenPauseBanner(result.matchedPattern, wakeAt, decision.source));
  await logger.log('screen_pause_due', { matched: result.matchedPattern, wakeAt, source: decision.source, sessionId: context.sessionId });

  const menuKeys = resolveLimitMenuKeys(target, config.limitMenuKeys);
  if (menuKeys) {
    const steps = parseKeySequenceSteps(menuKeys);
    if (steps.length > 0) {
      setTimeout(() => {
        void sendKeySequence(child, steps).then(() => logger.log('menu_keys_sent', { keys: menuKeys }));
      }, 500);
    }
  }

  scheduler.pauseUntil(wakeAt, { skipVerify: true });
}

async function handleSchedulerEvent(event: SchedulerEvent, context: SchedulerContext): Promise<void> {
  const { config, target, stateStore, logger, child, scheduler, scanner, spySetup, rateLimitsWatcher } = context;

  if (event.type === 'wake-due') {
    const persisted = await stateStore.load();

    if (scanner && scanner.getBusyState().state === 'BUSY') {
      printBanner(formatScreenWakeSkipped());
      await stateStore.clear();
      await clearStatusLineHint(spySetup?.statusLineHintFilePath);
      context.paused = false;
      scanner.resume();
      rateLimitsWatcher?.reset();
      await logger.log('wake_skipped_user_active', { target: target.name });
      scheduler.resumePolling();
      return;
    }

    if (persisted && persisted.auto_resume === false) {
      await stateStore.clear();
      await clearStatusLineHint(spySetup?.statusLineHintFilePath);
      context.paused = false;
      scanner?.resume();
      rateLimitsWatcher?.reset();
      await logger.log('wake_skipped_no_resume', { target: target.name });
      scheduler.resumePolling();
      return;
    }

    await stateStore.save({
      version: 2,
      state: 'waking',
      trigger: null,
      target: target.name,
      adapter_id: context.adapter.id,
      wake_at: new Date().toISOString(),
      pid: child.pid,
      auto_resume: true,
      session_id: context.sessionId,
    });
    await sendWakeSequence(child, { target: target.name, resumeHint: config.resumeHint });
    await stateStore.clear();
    await clearStatusLineHint(spySetup?.statusLineHintFilePath);
    context.paused = false;
    scanner?.resume();
    rateLimitsWatcher?.reset();
    await logger.log('wake_sent', { target: target.name });
    scheduler.resumePolling();
    return;
  }

  if (event.type === 'verify-pushed') {
    printBanner(formatVerifyPushed(event.nextWakeAt));
    const current = await stateStore.load();
    if (current) {
      await stateStore.save({ ...current, wake_at: event.nextWakeAt });
      if (spySetup && current.trigger) await writeStatusLineHint(spySetup.statusLineHintFilePath, event.nextWakeAt, current.trigger);
    }
    await logger.log('verify_pushed', { attempt: event.attempt, nextWakeAt: event.nextWakeAt, error: event.error });
    return;
  }

  if (event.type === 'error') {
    await logger.log('scheduler_error', { error: event.error });
  }
}

function shouldInjectStatusLineSpy(target: TargetCommand): boolean {
  return target.name === 'claude' || target.name === 'ccs';
}

function shouldWatchStatusLineRateLimits(target: TargetCommand, env: NodeJS.ProcessEnv): boolean {
  if (target.name === 'ccs') return (target.args[0] ?? '').toLowerCase() === 'claude';
  if (target.name !== 'claude') return false;
  const baseUrl = (env.ANTHROPIC_BASE_URL ?? '').toLowerCase();
  return !baseUrl || baseUrl.includes('api.anthropic.com');
}

function resolveLimitMenuKeys(target: TargetCommand, configuredKeys: string): string | undefined {
  if (configuredKeys.length > 0) return configuredKeys;
  if (target.name === 'claude') return 'enter';
  if (target.name === 'ccs' && (target.args[0] ?? '').toLowerCase() === 'claude') return 'enter';
  return undefined;
}

function injectSettingsArgs(target: TargetCommand, args: string[], settingsOverride: string): string[] {
  if (target.name === 'ccs' && args.length > 0 && !args[0].startsWith('-')) {
    return [args[0], '--settings', settingsOverride, ...args.slice(1)];
  }
  return ['--settings', settingsOverride, ...args];
}

function triggerTargetFor(target: TargetCommand): 'claude' | 'codex' {
  if (target.name === 'codex') return 'codex';
  if (target.name === 'ccs' && (target.args[0] ?? '').toLowerCase() === 'codex') return 'codex';
  return 'claude';
}

function printBanner(message: string): void {
  process.stderr.write(`\r\n${message}\r\n`);
}
