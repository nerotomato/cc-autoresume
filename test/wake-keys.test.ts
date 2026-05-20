import { describe, expect, it } from 'vitest';
import { sendWakeSequence } from '../src/wake-keys';

describe('sendWakeSequence', () => {
  it('发送 Esc、等待、提示词和回车', async () => {
    const writes: string[] = [];
    const delays: number[] = [];

    await sendWakeSequence(
      { write: (data) => writes.push(data) },
      {
        target: 'claude',
        resumeHint: '继续',
        delayMs: 123,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(writes).toEqual(['\x1b', '继续', '\r']);
    expect(delays).toEqual([123]);
  });
});
