import fs from 'node:fs/promises';
import path from 'node:path';
import type { PauseTrigger, RuntimeStateName } from './state-machine';

export interface PersistedState {
  version: 1;
  state: RuntimeStateName;
  trigger: PauseTrigger;
  target: string;
  adapter_id?: string;
  paused_at?: string;
  resets_at?: string;
  wake_at?: string;
  pid?: number;
  error?: string;
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

function isPersistedState(value: unknown): value is PersistedState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && typeof record.state === 'string' && typeof record.target === 'string';
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}
