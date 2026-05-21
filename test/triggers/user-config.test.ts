import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadUserTriggers } from '../../src/triggers/user-config';

async function tempFile(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-triggers-test-'));
  const filePath = path.join(dir, 'triggers.json');
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

describe('loadUserTriggers', () => {
  it('文件不存在返回 undefined', () => {
    expect(loadUserTriggers('/tmp/definitely-does-not-exist-cc-triggers.json')).toBeUndefined();
  });

  it('解析有效 JSON 并把字符串转为 RegExp', async () => {
    const filePath = await tempFile(JSON.stringify({
      patterns: ['my-custom-limit', '另一个限额'],
      busyMarkers: ['SPINNER'],
      resetExtractors: [{ type: 'relative', pattern: 'wait (\\d+)', unit: 'sec' }],
    }));

    const result = loadUserTriggers(filePath);
    expect(result?.patterns).toHaveLength(2);
    expect(result?.patterns?.[0].test('my-custom-limit')).toBe(true);
    expect(result?.busyMarkers).toHaveLength(1);
    expect(result?.resetExtractors).toHaveLength(1);
  });

  it('损坏的 JSON 返回 undefined 而不是抛错', async () => {
    const filePath = await tempFile('not-json');
    expect(loadUserTriggers(filePath)).toBeUndefined();
  });

  it('非法 regex 被跳过但不影响其他字段', async () => {
    const filePath = await tempFile(JSON.stringify({
      patterns: ['valid', '[unclosed'],
    }));
    const result = loadUserTriggers(filePath);
    expect(result?.patterns).toHaveLength(1);
  });
});
