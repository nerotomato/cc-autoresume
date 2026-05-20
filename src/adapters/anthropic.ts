import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AdapterError, SubscriptionUsageSnapshot, UsageAdapter, UsageWindow } from './types';

const usageEndpoint = 'https://api.anthropic.com/api/oauth/usage';

export const anthropicAdapter: UsageAdapter = {
  id: 'anthropic',
  kind: 'subscription',
  matches(env) {
    const baseUrl = env.ANTHROPIC_BASE_URL;
    return !baseUrl || baseUrl.includes('api.anthropic.com');
  },
  async fetch(env) {
    const token = await readAnthropicToken(env);
    if (!token) return { error: '未找到 Anthropic OAuth token', authFailed: true };

    try {
      const response = await fetch(usageEndpoint, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
      });

      if (!response.ok) return classifyHttpError(response.status);

      const body = await response.json();
      const parsed = parseAnthropicUsageResponse(body, Date.now());
      if (!parsed) return { error: 'Anthropic usage 响应缺少 5h/7d 窗口数据' };
      return parsed;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
};

export async function readAnthropicToken(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (env.ANTHROPIC_AUTH_TOKEN) return env.ANTHROPIC_AUTH_TOKEN;
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return env.CLAUDE_CODE_OAUTH_TOKEN;

  const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    const raw = await fs.readFile(credentialsPath, 'utf8');
    const json = JSON.parse(raw) as unknown;
    return findToken(json);
  } catch {
    return undefined;
  }
}

export function parseAnthropicUsageResponse(value: unknown, fetchedAt: number): SubscriptionUsageSnapshot | null {
  const candidates = collectCandidates(value);
  const fiveHour = firstWindow(candidates, ['five_hour', 'fiveHour', '5h', 'five_hour_window', 'fiveHourWindow']);
  const sevenDay = firstWindow(candidates, ['seven_day', 'sevenDay', '7d', 'seven_day_window', 'sevenDayWindow']);

  if (!fiveHour && !sevenDay) return null;

  return {
    kind: 'subscription',
    five_hour: fiveHour,
    seven_day: sevenDay,
    fetched_at: fetchedAt,
  };
}

function classifyHttpError(status: number): AdapterError {
  if (status === 401 || status === 403) return { error: `Anthropic usage 请求认证失败：${status}`, status, authFailed: true };
  if (status === 429 || status >= 500) return { error: `Anthropic usage 请求暂时失败：${status}`, status, transient: true };
  return { error: `Anthropic usage 请求失败：${status}`, status };
}

function collectCandidates(value: unknown): Record<string, unknown>[] {
  const root = asRecord(value);
  if (!root) return [];
  const nestedKeys = ['usage', 'limits', 'quota', 'data'];
  const nested = nestedKeys.map((key) => asRecord(root[key])).filter((item): item is Record<string, unknown> => item !== undefined);
  return [root, ...nested];
}

function firstWindow(candidates: Record<string, unknown>[], keys: string[]): UsageWindow | undefined {
  for (const candidate of candidates) {
    for (const key of keys) {
      const window = normalizeWindow(candidate[key]);
      if (window) return window;
    }
  }
  return undefined;
}

function normalizeWindow(value: unknown): UsageWindow | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const utilization = normalizeUtilization(record.utilization ?? record.used_percent ?? record.usedPercent ?? record.percent);
  if (utilization === undefined) return undefined;

  const resetsAt = normalizeResetAt(record.resets_at ?? record.resetsAt ?? record.reset_at ?? record.resetAt ?? record.nextResetTime);
  return resetsAt ? { utilization, resets_at: resetsAt } : { utilization };
}

function normalizeUtilization(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value > 0 && value <= 1) return value * 100;
  return value;
}

function normalizeResetAt(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }

  return undefined;
}

function findToken(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const direct = firstString(record, ['accessToken', 'access_token', 'oauthToken', 'oauth_token']);
  if (direct) return direct;

  for (const key of ['claudeAiOauth', 'claude_ai_oauth', 'oauth', 'auth']) {
    const nested = findToken(record[key]);
    if (nested) return nested;
  }

  return undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
