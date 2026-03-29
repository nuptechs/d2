// ============================================================
// probe report <session-file> — Generate report from saved session
// ============================================================

import type { Command } from 'commander';
import type { DebugSession, ProbeEvent, CorrelationGroup } from '@probe/core';
import { DEFAULT_CORRELATION_CONFIG } from '@probe/core';

interface ReportOptions {
  format: string;
  output: string;
  includeScreenshots: boolean;
  includeBodies: boolean;
}

interface SavedSession {
  session: DebugSession;
  events: ProbeEvent[];
}

export function registerReportCommand(program: Command): void {
  program
    .command('report <session-file>')
    .description('Generate a report from a saved session file')
    .option('--format <format>', 'report format: html, json, markdown', 'html')
    .option('--output <path>', 'output path for the report')
    .option('--include-screenshots', 'include screenshots in report', true)
    .option('--include-bodies', 'include request/response bodies', false)
    .action(async (sessionFile: string, opts: ReportOptions) => {
      await runReport(sessionFile, opts);
    });
}

async function runReport(sessionFile: string, opts: ReportOptions): Promise<void> {
  const chalk = (await import('chalk')).default;
  const ora = (await import('ora')).default;
  const { readFile, writeFile, mkdir } = await import('node:fs/promises');
  const { join, dirname, basename } = await import('node:path');

  const spinner = ora('Loading session...').start();

  try {
    const raw = await readFile(sessionFile, 'utf-8');
    const saved: SavedSession = JSON.parse(raw) as SavedSession;

    spinner.text = 'Correlating events...';

    const { createCorrelator } = await import('@probe/correlation-engine');
    const correlator = createCorrelator(
      saved.session.config.correlation ?? DEFAULT_CORRELATION_CONFIG,
    );

    for (const event of saved.events) {
      correlator.ingest(event);
    }

    const timeline = correlator.buildTimeline();
    const groups: CorrelationGroup[] = correlator.getGroups();

    spinner.text = 'Generating report...';

    const { createReporter } = await import('@probe/reporter');
    const reporter = createReporter(opts.format as 'html' | 'json' | 'markdown');

    const reportContent = await reporter.generate(
      { session: saved.session, timeline, correlationGroups: groups },
      {
        includeScreenshots: opts.includeScreenshots,
        includeRequestBodies: opts.includeBodies,
      },
    );

    const ext = reporter.getFileExtension();
    const outputPath =
      opts.output ?? join(dirname(sessionFile), `${basename(sessionFile, '.session.json')}.${ext}`);

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, reportContent, 'utf-8');

    spinner.succeed(`Report generated: ${outputPath}`);
    console.log(chalk.dim(`  Format: ${opts.format}`));
    console.log(chalk.dim(`  Events: ${saved.events.length}`));
    console.log(chalk.dim(`  Groups: ${groups.length}`));
  } catch (error) {
    spinner.fail(`Report failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
