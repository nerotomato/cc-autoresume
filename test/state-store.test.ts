import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateStore, isProcessAlive, listStateCandidates, sweepStaleStates, type PersistedState } from '../src/state-store';

async function tempStateDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-autoresume-test-'));
}

async function tempStatePath(): Promise<string> {
  return path.join(await tempStateDir(), 'state.json');
}

function state(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    version: 2,
    state: 'paused',
    trigger: 'screen',
    target: 'claude',
    paused_at: '2026-05-21T10:00:00.000Z',
    wake_at: '2026-05-21T15:00:00.000Z',
    pid: 123,
    auto_resume: true,
    wake_source: 'text',
    ...overrides,
  };
}

describe('StateStore', () => {
  it('不存在文件时返回 null', async () => {
    const store = new StateStore(await tempStatePath());

    await expect(store.load()).resolves.toBeNull();
  });

  it('保存后能读回', async () => {
    const store = new StateStore(await tempStatePath());
    const state = {
      version: 2 as const,
      state: 'paused' as const,
      trigger: '5h' as const,
      target: 'claude',
      wake_at: '2026-05-20T10:00:00.000Z',
      pid: 123,
      auto_resume: true,
      wake_source: 'api' as const,
    };

    await store.save(state);

    await expect(store.load()).resolves.toEqual(state);
  });

  it('保存带 session_id 的 state 能完整读回', async () => {
    const store = new StateStore(await tempStatePath());
    const stateWithSession: PersistedState = {
      version: 2,
      state: 'paused',
      trigger: 'screen',
      target: 'claude',
      paused_at: '2026-05-21T10:00:00.000Z',
      wake_at: '2026-05-21T15:00:00.000Z',
      pid: 999,
      auto_resume: true,
      wake_source: 'text',
      session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    };

    await store.save(stateWithSession);

    await expect(store.load()).resolves.toEqual(stateWithSession);
  });

  it('clear 会删除状态文件', async () => {
    const store = new StateStore(await tempStatePath());
    await store.save({ version: 2, state: 'idle', trigger: null, target: 'claude', auto_resume: false });
    await store.clear();

    await expect(store.load()).resolves.toBeNull();
  });

  it('遇到 v1 旧格式视为 stale 返回 null', async () => {
    const filePath = await tempStatePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ version: 1, state: 'paused', target: 'claude' }), 'utf8');

    await expect(new StateStore(filePath).load()).resolves.toBeNull();
  });

  it('损坏 JSON 返回 null', async () => {
    const filePath = await tempStatePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'bad-json', 'utf8');
    const store = new StateStore(filePath);

    await expect(store.load()).resolves.toBeNull();
  });
});

describe('listStateCandidates', () => {
  it('扫描 state-*.json 和老格式 state.json，跳过坏文件和无关文件', async () => {
    const dir = await tempStateDir();
    await new StateStore(path.join(dir, 'state-100.json')).save(state({ pid: 100 }));
    await new StateStore(path.join(dir, 'state-200.json')).save(state({ pid: 200 }));
    await new StateStore(path.join(dir, 'state.json')).save(state({ pid: 300 }));
    await fs.writeFile(path.join(dir, 'state-bad.json'), JSON.stringify(state({ pid: 400 })), 'utf8');
    await fs.writeFile(path.join(dir, 'state-500.json'), 'bad-json', 'utf8');
    await fs.writeFile(path.join(dir, 'notes.json'), JSON.stringify(state({ pid: 600 })), 'utf8');

    const candidates = await listStateCandidates(dir);

    expect(candidates.map((c) => path.basename(c.filePath)).sort()).toEqual(['state-100.json', 'state-200.json', 'state.json']);
    expect(candidates.map((c) => c.state.pid).sort()).toEqual([100, 200, 300]);
  });

  it('目录不存在时返回空数组', async () => {
    const dir = path.join(await tempStateDir(), 'missing');

    await expect(listStateCandidates(dir)).resolves.toEqual([]);
  });
});

describe('sweepStaleStates', () => {
  it('PID 已死立即清，不再等 maxAge；活进程 + 年轻 state 保留', async () => {
    const dir = await tempStateDir();
    // 100：dead + 远超 maxAge → 收
    // 200：alive + 年轻 → 保留（活进程的最新 state 必须留）
    // 300：dead + 远小于 maxAge → 立即收（核心改动）
    // 400：dead + 无 paused_at → 也收（PID 已死即可清，不再要求 paused_at）
    // 500：alive + 无 paused_at → 保留
    await new StateStore(path.join(dir, 'state-100.json')).save(state({ pid: 100, paused_at: '2026-05-19T00:00:00.000Z' }));
    await new StateStore(path.join(dir, 'state-200.json')).save(state({ pid: 200, paused_at: '2026-05-21T11:00:00.000Z' }));
    await new StateStore(path.join(dir, 'state-300.json')).save(state({ pid: 300, paused_at: '2026-05-21T11:00:00.000Z' }));
    await new StateStore(path.join(dir, 'state-400.json')).save(state({ pid: 400, paused_at: undefined }));
    await new StateStore(path.join(dir, 'state-500.json')).save(state({ pid: 500, paused_at: undefined }));

    const swept = await sweepStaleStates(
      dir,
      24 * 60 * 60 * 1000,
      Date.parse('2026-05-21T12:00:00.000Z'),
      (pid) => pid === 200 || pid === 500,
    );

    expect(swept.map((filePath) => path.basename(filePath)).sort()).toEqual([
      'state-100.json',
      'state-300.json',
      'state-400.json',
    ]);
    const remaining = await listStateCandidates(dir);
    expect(remaining.map((c) => path.basename(c.filePath)).sort()).toEqual(['state-200.json', 'state-500.json']);
  });

  it('活进程 + paused_at 超过 maxAge 兜底清理', async () => {
    const dir = await tempStateDir();
    await new StateStore(path.join(dir, 'state-700.json')).save(state({ pid: 700, paused_at: '2026-05-19T00:00:00.000Z' }));

    const swept = await sweepStaleStates(
      dir,
      24 * 60 * 60 * 1000,
      Date.parse('2026-05-21T12:00:00.000Z'),
      () => true,
    );

    expect(swept.map((filePath) => path.basename(filePath))).toEqual(['state-700.json']);
  });
});

describe('isProcessAlive', () => {
  it('识别当前进程存活', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});
