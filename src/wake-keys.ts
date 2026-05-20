export interface WritablePty {
  write(data: string): void;
}

export interface WakeSequenceOptions {
  target: 'claude' | 'codex';
  resumeHint: string;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function sendWakeSequence(pty: WritablePty, options: WakeSequenceOptions): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  pty.write('\x1b');
  await sleep(options.delayMs ?? 200);
  pty.write(options.resumeHint);
  pty.write('\r');
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
