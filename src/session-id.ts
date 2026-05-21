import { randomUUID } from 'node:crypto';

// wrapper 给 claude 子进程指定 session UUID，让会话可追踪
// 严格按 claude CLI 语义：--session-id 新建并指定 ID；--resume 恢复已有 session
// wrapper 不混用：默认场景下注入 --session-id 新建；用户已表达 session 意图时尊重原样

export type SessionSource = 'generated' | 'user-session-id' | 'user-resume' | 'untracked';

export interface SessionDecision {
  sessionId: string | undefined; // wrapper 跟踪的 UUID；undefined = 不跟踪
  injectedArgs: string[];        // 最终传给 pty.spawn 的 args
  source: SessionSource;
}

export interface ParsedSessionArgs {
  hasContinue: boolean;          // -c / --continue
  hasFork: boolean;              // --fork-session
  hasFromPr: boolean;            // --from-pr（可带值可不带）
  explicitSessionId?: string;    // --session-id <uuid> / --session-id=<uuid>
  explicitResumeId?: string;     // -r <uuid> 或 --resume <uuid> / --resume=<uuid>
  resumePickerMode: boolean;     // -r / --resume 后面没值（picker 模式）
}

// 用户表达过 session 意图、wrapper 不再插手的标志
function hasUntrackableIntent(parsed: ParsedSessionArgs): boolean {
  return parsed.hasContinue || parsed.hasFork || parsed.hasFromPr || parsed.resumePickerMode;
}

function isFlagLike(value: string | undefined): boolean {
  if (value === undefined) return true;
  return value.startsWith('-');
}

export function parseSessionArgs(args: string[]): ParsedSessionArgs {
  const result: ParsedSessionArgs = {
    hasContinue: false,
    hasFork: false,
    hasFromPr: false,
    resumePickerMode: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '-c' || arg === '--continue') {
      result.hasContinue = true;
      continue;
    }
    if (arg === '--fork-session') {
      result.hasFork = true;
      continue;
    }
    if (arg === '--from-pr' || arg.startsWith('--from-pr=')) {
      result.hasFromPr = true;
      continue;
    }
    if (arg.startsWith('--session-id=')) {
      result.explicitSessionId = arg.slice('--session-id='.length);
      continue;
    }
    if (arg === '--session-id') {
      const next = args[i + 1];
      if (!isFlagLike(next)) {
        result.explicitSessionId = next;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--resume=')) {
      result.explicitResumeId = arg.slice('--resume='.length);
      continue;
    }
    if (arg === '--resume' || arg === '-r') {
      const next = args[i + 1];
      if (isFlagLike(next)) {
        result.resumePickerMode = true;
      } else {
        result.explicitResumeId = next;
        i += 1;
      }
      continue;
    }
  }

  return result;
}

export interface DecideSessionInput {
  args: string[];
  generateUuid?: () => string; // 注入便于测试
}

export function decideSession(input: DecideSessionInput): SessionDecision {
  const parsed = parseSessionArgs(input.args);

  if (parsed.explicitSessionId !== undefined) {
    return { sessionId: parsed.explicitSessionId, injectedArgs: input.args, source: 'user-session-id' };
  }
  if (parsed.explicitResumeId !== undefined) {
    return { sessionId: parsed.explicitResumeId, injectedArgs: input.args, source: 'user-resume' };
  }
  if (hasUntrackableIntent(parsed)) {
    return { sessionId: undefined, injectedArgs: input.args, source: 'untracked' };
  }

  const uuid = (input.generateUuid ?? randomUUID)();
  return {
    sessionId: uuid,
    injectedArgs: ['--session-id', uuid, ...input.args],
    source: 'generated',
  };
}
