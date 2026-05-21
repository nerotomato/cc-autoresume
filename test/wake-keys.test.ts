import { describe, expect, it } from 'vitest';
import { parseKeySequenceSteps, sendKeySequence, sendWakeSequence } from '../src/wake-keys';

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

describe('sendKeySequence', () => {
  it('方向键和回车按 ANSI 转义发送', async () => {
    const writes: string[] = [];
    const delays: number[] = [];

    await sendKeySequence(
      { write: (data) => writes.push(data) },
      [{ key: 'up' }, { key: 'up' }, { key: 'enter' }],
      { sleep: async (ms) => { delays.push(ms); } },
    );

    expect(writes).toEqual(['\x1b[A', '\x1b[A', '\r']);
    expect(delays).toHaveLength(3); // 每个 step 后都 sleep 一下
  });

  it('literal 类型按原样写入', async () => {
    const writes: string[] = [];
    await sendKeySequence(
      { write: (data) => writes.push(data) },
      [{ key: 'literal', literal: 'y' }, { key: 'enter' }],
      { sleep: async () => {} },
    );

    expect(writes).toEqual(['y', '\r']);
  });

  it('未知键名静默跳过', async () => {
    const writes: string[] = [];
    await sendKeySequence(
      { write: (data) => writes.push(data) },
      [{ key: 'nonsense' }, { key: 'enter' }],
      { sleep: async () => {} },
    );

    expect(writes).toEqual(['\r']);
  });
});

describe('parseKeySequenceSteps', () => {
  it('解析 up,up,enter 风格的逗号分隔配置', () => {
    expect(parseKeySequenceSteps('up,up,enter')).toEqual([{ key: 'up' }, { key: 'up' }, { key: 'enter' }]);
  });

  it('忽略空格和大小写', () => {
    expect(parseKeySequenceSteps(' Down , ENTER ')).toEqual([{ key: 'down' }, { key: 'enter' }]);
  });

  it('未知键名被跳过', () => {
    expect(parseKeySequenceSteps('up,foo,enter')).toEqual([{ key: 'up' }, { key: 'enter' }]);
  });

  it('空字符串返回空数组', () => {
    expect(parseKeySequenceSteps('')).toEqual([]);
  });
});
