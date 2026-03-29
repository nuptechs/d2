// ============================================================
// probe replay <session-file> — Replay events chronologically
// ============================================================

import type { Command } from 'commander';
import type { DebugSession, ProbeEvent } from '@probe/core';
import { formatEvent } from '../utils/output.js';

interface ReplayOptions {
  speed: string;
  filter?: string;
}

interface SavedSession {
  session: DebugSession;
  events: ProbeEvent[];
}

export function registerReplayCommand(program: Command): void {
  program
    .command('replay <session-file>')
    .description('Replay a saved session chronologically in the terminal')
    .option('--speed <multiplier>', 'playback speed (1=realtime, 0=instant)', '0')
    .option('--filter <source>', 'filter by source: browser, network, log, sdk')
    .action(async (sessionFile: string, opts: ReplayOptions) => {
      await runReplay(sessionFile, opts);
    });
}

async function runReplay(sessionFile: string, opts: ReplayOptions): Promise<void> {
  const chalk = (await import('chalk')).default;
  const { readFile } = await import('node:fs/promises');

  const speed = parseFloat(opts.speed);

  try {
    const raw = await readFile(sessionFile, 'utf-8');
    const saved: SavedSession = JSON.parse(raw) as SavedSession;

    let events = [...saved.events].sort((a, b) => a.timestamp - b.timestamp);

    if (opts.filter) {
      const sources = opts.filter.split(',').map((s) => s.trim());
      events = events.filter((e) => sources.includes(e.source));
    }

    if (events.length === 0) {
      console.log(chalk.yellow('No events to replay.'));
      return;
    }

    console.log(chalk.bold('Debug Probe — Replay Mode'));
    console.log(chalk.dim(`  Session: ${saved.session.name}`));
    console.log(chalk.dim(`  Events: ${events.length}`));
    console.log(chalk.dim(`  Speed: ${speed === 0 ? 'instant' : `${speed}x`}`));
    if (opts.filter) console.log(chalk.dim(`  Filter: ${opts.filter}`));
    console.log('');

    const baseTime = events[0]!.timestamp;
    let lastTimestamp = baseTime;

    for (const event of events) {
      // Delay for realtime replay
      if (speed > 0) {
        const delta = event.timestamp - lastTimestamp;
        if (delta > 0) {
          const delayMs = delta / speed;
          await sleep(Math.min(delayMs, 5000)); // cap at 5s
        }
      }

      const relativeMs = event.timestamp - baseTime;
      const timeStr = formatRelativeTime(relativeMs);
      const groupIndicator = event.correlationId
        ? chalk.dim(` [${event.correlationId.slice(0, 8)}]`)
        : '';

      console.log(`${chalk.dim(timeStr)}${groupIndicator} ${formatEvent(event)}`);

      lastTimestamp = event.timestamp;
    }

    console.log('');
    console.log(chalk.dim('Replay complete.'));
  } catch (error) {
    console.error(chalk.red(`Replay failed: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatRelativeTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const millis = ms % 1000;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `+${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}
