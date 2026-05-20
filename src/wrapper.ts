import * as pty from 'node-pty';
import type { Config } from './config';
import type { Logger } from './logger';
import { Scheduler, type SchedulerEvent } from './scheduler';
import { formatAutoWakeBanner, formatBalanceWarning, formatTooLongBanner, formatVerifyFailed } from './side-banner';
import { isProcessAlive, type PersistedState, type StateStore } from './state-store';
import type { TargetCommand } from './target';
import { sendWakeSequence } from './wake-keys';
import type { UsageAdapter } from './adapters/types';

export interface WrapperOptions {
  config: Config;
  target: TargetCommand;
  adapter: UsageAdapter;
  stateStore: StateStore;
  logger: Logger;
}

export async function runWrapper(options: WrapperOptions): Promise<number> {
  const { config, target, adapter, stateStore, logger } = options;
  const child = pty.spawn(target.command, target.args, {
    name: process.env.TERM || 'xterm-256color',
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    cwd: process.cwd(),
    env: process.env,
  });

  await logger.log('wrapper_start', { target: target.name, command: target.command, pid: child.pid, adapter: adapter.id });
  await handleExistingState(stateStore, logger, child.pid);

  const scheduler = new Scheduler({
    adapter,
    env: process.env,
    threshold: config.threshold,
    maxWaitHours: config.maxWaitHours,
    balanceWarn: config.balanceWarn,
    wakeBufferMs: config.wakeBufferMs,
    onEvent: async (event) => {
      await handleSchedulerEvent(event, { config, target, adapter, stateStore, logger, child, scheduler });
    },
  });

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
      child.write(data.toString('binary'));
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
}

async function handleSchedulerEvent(event: SchedulerEvent, context: SchedulerContext): Promise<void> {
  const { config, target, adapter, stateStore, logger, child, scheduler } = context;

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
    const state: PersistedState = {
      version: 1,
      state: event.mode,
      trigger: event.trigger,
      target: target.name,
      adapter_id: adapter.id,
      paused_at: new Date().toISOString(),
      resets_at: event.resetsAt,
      wake_at: event.wakeAt,
      pid: child.pid,
    };
    await stateStore.save(state);
    printBanner(event.mode === 'paused'
      ? formatAutoWakeBanner(event.trigger, event.wakeAt)
      : formatTooLongBanner(event.trigger, event.wakeAt, config.maxWaitHours));
    await logger.log('pause_due', { mode: event.mode, trigger: event.trigger, wakeAt: event.wakeAt });
    return;
  }

  if (event.type === 'wake-due') {
    await stateStore.save({
      version: 1,
      state: 'waking',
      trigger: null,
      target: target.name,
      adapter_id: adapter.id,
      wake_at: new Date().toISOString(),
      pid: child.pid,
    });
    await sendWakeSequence(child, { target: target.name, resumeHint: config.resumeHint });
    await stateStore.clear();
    await logger.log('wake_sent', { target: target.name });
    scheduler.resumePolling();
    return;
  }

  if (event.type === 'verify-failed') {
    printBanner(formatVerifyFailed(event.attempt, event.maxAttempts));
    await logger.log('verify_failed', { attempt: event.attempt, maxAttempts: event.maxAttempts, error: event.error });
    return;
  }

  if (event.type === 'error') {
    await logger.log('scheduler_error', { error: event.error });
  }
}

async function handleExistingState(stateStore: StateStore, logger: Logger, currentPid: number): Promise<void> {
  const state = await stateStore.load();
  if (!state?.pid) return;

  if (!isProcessAlive(state.pid)) {
    await logger.log('stale_state_cleared', { pid: state.pid, state: state.state });
    await stateStore.clear();
    return;
  }

  if (state.pid !== currentPid) {
    printBanner(`[cc-autoresume] 检测到另一个 wrapper 状态仍在运行：pid ${state.pid}`);
    await logger.log('active_state_detected', { pid: state.pid, state: state.state });
  }
}

function printBanner(message: string): void {
  process.stderr.write(`\r\n${message}\r\n`);
}
