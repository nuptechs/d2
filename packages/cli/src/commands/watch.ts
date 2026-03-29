// ============================================================
// probe watch — Real-time log monitoring (no browser)
// ============================================================

import type { Command } from 'commander';
import type { LogCollectorConfig, LogEvent, LogLevel } from '@probe/core';
import { formatEvent } from '../utils/output.js';

interface WatchOptions {
  logFile?: string;
  docker?: string;
  level: string;
  pattern?: string;
  config: string;
  verbose?: boolean;
}

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Real-time log monitoring mode')
    .option('--log-file <path>', 'log file to tail')
    .option('--docker <id>', 'Docker container to follow')
    .option('--level <level>', 'minimum log level to display', 'info')
    .option('--pattern <regex>', 'filter messages by regex pattern')
    .action(async (opts: WatchOptions) => {
      await runWatch(opts);
    });
}

async function runWatch(opts: WatchOptions): Promise<void> {
  const chalk = (await import('chalk')).default;

  const minLevel = LOG_LEVEL_ORDER[opts.level as LogLevel] ?? LOG_LEVEL_ORDER.info;
  const patternRegex = opts.pattern ? new RegExp(opts.pattern) : undefined;

  const configs: LogCollectorConfig[] = [];

  if (opts.logFile) {
    configs.push({
      enabled: true,
      source: { type: 'file', name: opts.logFile, path: opts.logFile },
    });
  }

  if (opts.docker) {
    configs.push({
      enabled: true,
      source: { type: 'docker', name: opts.docker, containerId: opts.docker },
    });
  }

  if (configs.length === 0) {
    console.error(chalk.red('Error: At least one log source is required (--log-file or --docker)'));
    process.exit(1);
  }

  console.log(chalk.bold('Debug Probe — Watch Mode'));
  console.log(chalk.dim(`  Level filter: >= ${opts.level}`));
  if (opts.pattern) console.log(chalk.dim(`  Pattern filter: ${opts.pattern}`));
  console.log(chalk.dim('  Press Ctrl+C to stop\n'));

  const disconnectors: Array<() => Promise<void>> = [];

  const handleLogEvent = (event: LogEvent): void => {
    const eventLevel = LOG_LEVEL_ORDER[event.level] ?? 0;
    if (eventLevel < minLevel) return;
    if (patternRegex && !patternRegex.test(event.message)) return;

    console.log(formatEvent(event));
  };

  try {
    const { createLogSource } = await import('@probe/log-collector');

    for (const config of configs) {
      const source = createLogSource(config);
      source.onLog(handleLogEvent);
      await source.connect(config);
      disconnectors.push(() => source.disconnect());

      const sourceName = config.source.path ?? config.source.containerId ?? config.source.name;
      console.log(chalk.green(`  ✓ Connected: ${sourceName}`));
    }

    console.log('');

    // Keep alive until SIGINT
    await new Promise<void>((resolve) => {
      const handler = (): void => {
        process.removeListener('SIGINT', handler);
        resolve();
      };
      process.on('SIGINT', handler);
    });
  } finally {
    console.log(chalk.dim('\nDisconnecting...'));
    for (const disconnect of disconnectors) {
      await disconnect().catch(() => {});
    }
    console.log(chalk.dim('Done.'));
  }
}
