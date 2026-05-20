import { parseConfig } from './config';
import { Logger } from './logger';
import { selectAdapter } from './adapters/registry';
import { StateStore } from './state-store';
import { resolveTarget } from './target';
import { runWrapper } from './wrapper';

export async function main(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = parseConfig(argv, env);
  const target = resolveTarget(config);
  const adapter = selectAdapter(config, env);
  const logger = new Logger(config.logPath);
  const stateStore = new StateStore(config.statePath);

  await logger.log('startup', { target: target.name, adapter: adapter.id });
  const exitCode = await runWrapper({ config, target, adapter, logger, stateStore });
  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[cc-autoresume] ${message}\n`);
    process.exitCode = 1;
  });
}
