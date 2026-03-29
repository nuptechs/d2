// ============================================================
// CLI output formatting — colored events, summaries, banner
// ============================================================

import type { ProbeEvent, DebugSession, Timeline, LogLevel, EventSource } from '@probe/core';
import { toIso, formatDuration } from '@probe/core';

// Lazy-loaded chalk instance
let _chalk: typeof import('chalk').default | undefined;

async function getChalk(): Promise<typeof import('chalk').default> {
  if (!_chalk) {
    _chalk = (await import('chalk')).default;
  }
  return _chalk;
}

// Synchronous fallback for module-level usage (chalk loaded lazily on first call)
let _chalkSync: typeof import('chalk').default | undefined;


export async function initOutput(): Promise<void> {
  _chalkSync = await getChalk();
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: 'gray',
  debug: 'gray',
  info: 'blue',
  warn: 'yellow',
  error: 'red',
  fatal: 'redBright',
};

const SOURCE_COLORS: Record<EventSource, string> = {
  browser: 'cyan',
  network: 'green',
  log: 'yellow',
  sdk: 'magenta',
  correlation: 'white',
};

export function formatEvent(event: ProbeEvent): string {
  const chalk = _chalkSync;
  if (!chalk) {
    // Fallback — no colors
    return `[${event.source}] ${describeEvent(event)}`;
  }

  const sourceColor = SOURCE_COLORS[event.source] ?? 'white';
  const colorFn = (chalk as unknown as Record<string, (s: string) => string>)[sourceColor] ?? chalk.white;
  const sourceTag = colorFn(`[${event.source}]`);
  const time = chalk.dim(toIso(event.timestamp));

  // Log events get level-colored messages
  if (event.source === 'log') {
    const logEvent = event as ProbeEvent & { level: LogLevel; message: string };
    const levelColor = LEVEL_COLORS[logEvent.level] ?? 'white';
    const levelFn = (chalk as unknown as Record<string, (s: string) => string>)[levelColor] ?? chalk.white;
    const levelTag = levelFn(logEvent.level.toUpperCase().padEnd(5));
    return `${time} ${sourceTag} ${levelTag} ${logEvent.message}`;
  }

  return `${time} ${sourceTag} ${describeEvent(event)}`;
}

function describeEvent(event: ProbeEvent): string {
  const e = event as unknown as Record<string, unknown>;

  switch (event.source) {
    case 'browser':
      switch (e['type']) {
        case 'click':
          return `Click: ${e['selector'] ?? 'unknown'}`;
        case 'navigation':
          return `Navigate: ${e['toUrl'] ?? e['pageUrl'] ?? ''}`;
        case 'screenshot':
          return `Screenshot (${e['trigger'] ?? 'manual'})`;
        case 'console':
          return `Console.${e['level']}: ${e['message'] ?? ''}`;
        case 'error':
          return `Error: ${e['message'] ?? 'unknown'}`;
        default:
          return `Browser: ${String(e['type'] ?? 'event')}`;
      }
    case 'network':
      if (e['type'] === 'request') return `→ ${e['method']} ${e['url']}`;
      if (e['type'] === 'response') return `← ${e['statusCode']} (${e['duration']}ms)`;
      return `Network: ${String(e['type'] ?? 'event')}`;
    case 'sdk':
      return `SDK: ${String(e['type'] ?? 'event')}`;
    case 'correlation':
      return `Correlation: group updated`;
    default:
      return `${event.source}: event`;
  }
}

export function formatSummary(session: DebugSession, timeline: Timeline): string {
  const chalk = _chalkSync;
  if (!chalk) {
    return [
      `\nSession: ${session.name}`,
      `  Events: ${timeline.stats.totalEvents}`,
      `  Groups: ${timeline.stats.correlationGroups}`,
      `  Errors: ${timeline.stats.errors}`,
      `  Duration: ${formatDuration(timeline.duration)}`,
    ].join('\n');
  }

  const lines = [
    '',
    chalk.bold(`  Session: ${session.name}`),
    chalk.dim(`  Events:  ${timeline.stats.totalEvents}`),
    chalk.dim(`  Groups:  ${timeline.stats.correlationGroups}`),
    timeline.stats.errors > 0
      ? chalk.red(`  Errors:  ${timeline.stats.errors}`)
      : chalk.dim(`  Errors:  0`),
    chalk.dim(`  Duration: ${formatDuration(timeline.duration)}`),
  ];

  const bySource = timeline.stats.bySource;
  const sourceEntries = Object.entries(bySource).filter(([, count]) => count > 0);
  if (sourceEntries.length > 0) {
    lines.push(chalk.dim('  Sources:'));
    for (const [source, count] of sourceEntries) {
      lines.push(chalk.dim(`    ${source}: ${count}`));
    }
  }

  return lines.join('\n');
}

export function printBanner(): void {
  const chalk = _chalkSync;
  if (chalk) {
    console.log(chalk.bold.cyan('\n  🔍 Debug Probe v0.1.0\n'));
  } else {
    console.log('\n  Debug Probe v0.1.0\n');
  }
}
