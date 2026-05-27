import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RateLimitsWatcher, parseRateLimitsPayload } from '../src/rate-limits-watcher';
import type { WakeDecision } from '../src/state-machine';

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-autoresume-rate-test-'));
  return path.join(dir, 'rate-limits.json');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('parseRateLimitsPayload', () => {
  it('解析 Claude statusLine rate_limits', () => {
    const resetAt = '2026-05-20T10:00:00.000Z';
    const resetSeconds = Date.parse(resetAt) / 1000;
    const snapshot = parseRateLimitsPayload(JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 100, resets_at: resetAt },
        seven_day: { used_percentage: 50, resets_at: resetSeconds },
      },
    }), 123);

    expect(snapshot).toEqual({
      kind: 'subscription',
      fetched_at: 123,
      five_hour: { utilization: 100, resets_at: '2026-05-20T10:00:00.000Z' },
      seven_day: { utilization: 50, resets_at: '2026-05-20T10:00:00.000Z' },
    });
  });

  it('没有 rate_limits 时返回 null', () => {
    expect(parseRateLimitsPayload('{"model":"claude"}')).toBeNull();
  });
});

describe('RateLimitsWatcher', () => {
  it('达到阈值时触发一次 onLimitHit，并在 reset 后可再次触发', async () => {
    const filePath = await tempFile();
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    await fs.writeFile(filePath, JSON.stringify({ rate_limits: { five_hour: { used_percentage: 100, resets_at: resetAt } } }), 'utf8');
    const hits: WakeDecision[] = [];
    const watcher = new RateLimitsWatcher({
      filePath,
      threshold: 99,
      pollIntervalMs: 10_000,
      maxStalenessMs: 120_000,
      wakeBufferMs: 0,
      onLimitHit: (decision) => { hits.push(decision); },
    });

    watcher.start();
    await wait(20);
    await watcher.check();
    await watcher.check();

    expect(hits).toHaveLength(1);
    expect(hits[0].trigger).toBe('5h');

    watcher.reset();
    await watcher.check();
    expect(hits).toHaveLength(2);
    watcher.stop();
  });

  it('跳过过期文件', async () => {
    const filePath = await tempFile();
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    await fs.writeFile(filePath, JSON.stringify({ rate_limits: { five_hour: { used_percentage: 100, resets_at: resetAt } } }), 'utf8');
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(filePath, old, old);
    const hits: WakeDecision[] = [];
    const watcher = new RateLimitsWatcher({
      filePath,
      threshold: 99,
      pollIntervalMs: 10_000,
      maxStalenessMs: 1000,
      wakeBufferMs: 0,
      onLimitHit: (decision) => { hits.push(decision); },
    });

    watcher.start();
    await wait(20);

    expect(hits).toHaveLength(0);
    watcher.stop();
  });
});
