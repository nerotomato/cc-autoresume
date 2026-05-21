import fs from 'node:fs/promises';
import path from 'node:path';
import type { PauseTrigger, RuntimeStateName, WakeSource } from './state-machine';

export interface PersistedState {
  version: 2;
  state: RuntimeStateName;
  trigger: PauseTrigger;
  target: string;
  adapter_id?: string;
  paused_at?: string;
  resets_at?: string;
  wake_at?: string;
  pid?: number;
  error?: string;
  auto_resume: boolean;
  wake_source?: WakeSource;
  // wrapper 跟踪的 claude session UUID。撞墙后查 state 文件能直接看到该 resume 哪个 session
  session_id?: string;
}

export class StateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<PersistedState | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return isPersistedState(parsed) ? parsed : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      return null;
    }
  }

  async save(state: PersistedState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fs.rename(tmpPath, this.filePath);
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

export function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface StateCandidate {
  state: PersistedState;
  filePath: string;
}

// 扫整个 ~/.cc-autoresume/ 目录，把所有合法的 state-*.json + 老格式 state.json 当候选返回
// 损坏 / 非 v2 / 名字不匹配的统统跳过
export async function listStateCandidates(dir: string): Promise<StateCandidate[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (isNotFound(error)) return [];
    return [];
  }

  const candidates: StateCandidate[] = [];
  for (const name of entries) {
    if (!isStateFileName(name)) continue;
    const filePath = path.join(dir, name);
    const store = new StateStore(filePath);
    const state = await store.load();
    if (state) candidates.push({ state, filePath });
  }
  return candidates;
}

// 启动时清理：把 PID 不存活且 paused_at 超过 maxAgeMs 的 state 文件直接删掉
// 返回删了多少个，主要给日志和测试用
export async function sweepStaleStates(
  dir: string,
  maxAgeMs: number,
  nowMs: number = Date.now(),
  processAlive: (pid: number | undefined) => boolean = isProcessAlive,
): Promise<string[]> {
  const candidates = await listStateCandidates(dir);
  const swept: string[] = [];

  for (const { state, filePath } of candidates) {
    if (processAlive(state.pid)) continue;
    if (!state.paused_at) continue; // 没 paused_at 不好判断年龄，保守不删
    const ageMs = nowMs - new Date(state.paused_at).getTime();
    if (!Number.isFinite(ageMs) || ageMs <= maxAgeMs) continue;
    try {
      await fs.unlink(filePath);
      swept.push(filePath);
    } catch {
      // best effort
    }
  }
  return swept;
}

function isStateFileName(name: string): boolean {
  // 接受老格式 state.json（升级路径）和新格式 state-<pid>.json
  return name === 'state.json' || /^state-\d+\.json$/.test(name);
}

function isPersistedState(value: unknown): value is PersistedState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 2 &&
    typeof record.state === 'string' &&
    typeof record.target === 'string' &&
    typeof record.auto_resume === 'boolean'
  );
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}
