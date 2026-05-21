import { describe, expect, it } from 'vitest';
import { decideSession, parseSessionArgs } from '../src/session-id';

const FAKE_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('parseSessionArgs', () => {
  it('识别 -c / --continue', () => {
    expect(parseSessionArgs(['-c']).hasContinue).toBe(true);
    expect(parseSessionArgs(['--continue']).hasContinue).toBe(true);
    expect(parseSessionArgs(['hello']).hasContinue).toBe(false);
  });

  it('识别 --session-id 带值（空格分隔）', () => {
    const parsed = parseSessionArgs(['--session-id', FAKE_UUID]);
    expect(parsed.explicitSessionId).toBe(FAKE_UUID);
  });

  it('识别 --session-id=<uuid>', () => {
    const parsed = parseSessionArgs([`--session-id=${FAKE_UUID}`]);
    expect(parsed.explicitSessionId).toBe(FAKE_UUID);
  });

  it('识别 -r 带值', () => {
    const parsed = parseSessionArgs(['-r', FAKE_UUID]);
    expect(parsed.explicitResumeId).toBe(FAKE_UUID);
    expect(parsed.resumePickerMode).toBe(false);
  });

  it('-r 后面是 flag 当成 picker 模式', () => {
    const parsed = parseSessionArgs(['-r', '--debug']);
    expect(parsed.explicitResumeId).toBeUndefined();
    expect(parsed.resumePickerMode).toBe(true);
  });

  it('-r 在末尾当成 picker 模式', () => {
    const parsed = parseSessionArgs(['-r']);
    expect(parsed.explicitResumeId).toBeUndefined();
    expect(parsed.resumePickerMode).toBe(true);
  });

  it('--resume=<uuid> 和 --resume <uuid> 都能识别', () => {
    expect(parseSessionArgs([`--resume=${FAKE_UUID}`]).explicitResumeId).toBe(FAKE_UUID);
    expect(parseSessionArgs(['--resume', FAKE_UUID]).explicitResumeId).toBe(FAKE_UUID);
  });

  it('识别 --fork-session / --from-pr', () => {
    expect(parseSessionArgs(['--fork-session']).hasFork).toBe(true);
    expect(parseSessionArgs(['--from-pr']).hasFromPr).toBe(true);
    expect(parseSessionArgs(['--from-pr=123']).hasFromPr).toBe(true);
  });
});

describe('decideSession', () => {
  it('默认场景生成 UUID 并注入 --session-id', () => {
    const decision = decideSession({
      args: ['--debug'],
      generateUuid: () => FAKE_UUID,
    });

    expect(decision.source).toBe('generated');
    expect(decision.sessionId).toBe(FAKE_UUID);
    expect(decision.injectedArgs).toEqual(['--session-id', FAKE_UUID, '--debug']);
  });

  it('用户传 --session-id 时沿用且不重复注入', () => {
    const decision = decideSession({
      args: ['--session-id', FAKE_UUID, '--debug'],
      generateUuid: () => 'should-not-be-used',
    });

    expect(decision.source).toBe('user-session-id');
    expect(decision.sessionId).toBe(FAKE_UUID);
    expect(decision.injectedArgs).toEqual(['--session-id', FAKE_UUID, '--debug']);
  });

  it('用户传 -r <uuid> 时沿用此 ID 做 state 跟踪', () => {
    const decision = decideSession({
      args: ['-r', FAKE_UUID],
      generateUuid: () => 'should-not-be-used',
    });

    expect(decision.source).toBe('user-resume');
    expect(decision.sessionId).toBe(FAKE_UUID);
    expect(decision.injectedArgs).toEqual(['-r', FAKE_UUID]);
  });

  it('用户传 -c 时降级为 untracked，不注入 --session-id', () => {
    const decision = decideSession({
      args: ['-c'],
      generateUuid: () => 'should-not-be-used',
    });

    expect(decision.source).toBe('untracked');
    expect(decision.sessionId).toBeUndefined();
    expect(decision.injectedArgs).toEqual(['-c']);
  });

  it('用户传 --fork-session 时降级为 untracked', () => {
    const decision = decideSession({
      args: ['--fork-session'],
      generateUuid: () => 'should-not-be-used',
    });

    expect(decision.source).toBe('untracked');
    expect(decision.sessionId).toBeUndefined();
  });

  it('-r 无值（picker 模式）时降级为 untracked', () => {
    const decision = decideSession({
      args: ['-r'],
      generateUuid: () => 'should-not-be-used',
    });

    expect(decision.source).toBe('untracked');
    expect(decision.sessionId).toBeUndefined();
    expect(decision.injectedArgs).toEqual(['-r']);
  });

  it('用户同时传 -c 和 --session-id 时优先尊重 --session-id', () => {
    const decision = decideSession({
      args: ['-c', '--session-id', FAKE_UUID],
    });

    expect(decision.source).toBe('user-session-id');
    expect(decision.sessionId).toBe(FAKE_UUID);
  });
});
