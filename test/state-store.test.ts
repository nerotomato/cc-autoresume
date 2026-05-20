import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateStore, isProcessAlive } from '../src/state-store';

async function tempStatePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-autoresume-test-'));
  return path.join(dir, 'state.json');
}

describe('StateStore', () => {
  it('不存在文件时返回 null', async () => {
    const store = new StateStore(await tempStatePath());

    await expect(store.load()).resolves.toBeNull();
  });

  it('保存后能读回', async () => {
    const store = new StateStore(await tempStatePath());
    const state = {
      version: 1 as const,
      state: 'paused' as const,
      trigger: '5h' as const,
      target: 'claude',
      wake_at: '2026-05-20T10:00:00.000Z',
      pid: 123,
    };

    await store.save(state);

    await expect(store.load()).resolves.toEqual(state);
  });

  it('clear 会删除状态文件', async () => {
    const store = new StateStore(await tempStatePath());
    await store.save({ version: 1, state: 'idle', trigger: null, target: 'claude' });
    await store.clear();

    await expect(store.load()).resolves.toBeNull();
  });

  it('损坏 JSON 返回 null', async () => {
    const filePath = await tempStatePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'bad-json', 'utf8');
    const store = new StateStore(filePath);

    await expect(store.load()).resolves.toBeNull();
  });
});

describe('isProcessAlive', () => {
  it('识别当前进程存活', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});
