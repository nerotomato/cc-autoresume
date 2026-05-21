import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AdapterError, SubscriptionUsageSnapshot, UsageAdapter, UsageWindow } from './types';

const usageEndpoint = 'https://api.anthropic.com/api/oauth/usage';

// 模块级 token 缓存。主要服务于 CC_AUTORESUME_ENABLE_API_POLL=1 的高频轮询场景
// （命中率可达 99%+）。默认（屏幕扫描 only）下，整个会话最多触发 1 次 token 读取，
// 缓存基本不被命中——保留这层是为 opt-in 用户兜底，运行时开销为零。
let cachedToken: string | undefined;

export function invalidateAnthropicToken(): void {
  cachedToken = undefined;
}

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

      if (!response.ok) {
        // token 被 Claude Code 轮换过会回 401/403，清掉缓存让下次重读
        if (response.status === 401 || response.status === 403) invalidateAnthropicToken();
        return classifyHttpError(response.status);
      }

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
  if (cachedToken) return cachedToken;

  if (env.ANTHROPIC_AUTH_TOKEN) {
    cachedToken = env.ANTHROPIC_AUTH_TOKEN;
    return cachedToken;
  }
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    cachedToken = env.CLAUDE_CODE_OAUTH_TOKEN;
    return cachedToken;
  }

  // 优先 OS 原生凭据库：Claude Code 新版本在 macOS 上把 token 存 Keychain，
  // ~/.claude/.credentials.json 可能是旧登录流程的过期副本
  const fromKeychain = tryReadKeychain();
  if (fromKeychain) {
    cachedToken = fromKeychain;
    return cachedToken;
  }

  const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    const raw = await fs.readFile(credentialsPath, 'utf8');
    const token = extractClaudeOAuthToken(raw);
    if (token) cachedToken = token;
    return token;
  } catch {
    return undefined;
  }
}

function tryReadKeychain(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const result = spawnSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (result.status !== 0 || !result.stdout) return undefined;
    return extractClaudeOAuthToken(result.stdout);
  } catch {
    return undefined;
  }
}

function extractClaudeOAuthToken(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { claudeAiOauth?: { accessToken?: string } };
    return parsed.claudeAiOauth?.accessToken;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
