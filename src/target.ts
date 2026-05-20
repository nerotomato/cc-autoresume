import { spawnSync } from 'node:child_process';
import type { Config, TargetName } from './config';

export interface TargetCommand {
  name: Exclude<TargetName, 'auto'>;
  command: string;
  args: string[];
}

export function resolveTarget(config: Pick<Config, 'target' | 'targetArgs' | 'targetCommandOverride'>): TargetCommand {
  if (config.targetCommandOverride) {
    return {
      name: config.target === 'codex' ? 'codex' : 'claude',
      command: config.targetCommandOverride,
      args: config.targetArgs,
    };
  }

  if (config.target === 'claude' || config.target === 'codex') {
    return { name: config.target, command: config.target, args: config.targetArgs };
  }

  if (commandExists('claude')) return { name: 'claude', command: 'claude', args: config.targetArgs };
  if (commandExists('codex')) return { name: 'codex', command: 'codex', args: config.targetArgs };

  throw new Error('无法自动识别目标 CLI，请使用 --target=claude 或 --target=codex');
}

export function commandExists(command: string): boolean {
  const result = spawnSync('which', [command], { stdio: 'ignore' });
  return result.status === 0;
}
