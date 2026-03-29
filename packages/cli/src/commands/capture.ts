// ============================================================
// probe capture [url] — Full debug session capture
// ============================================================

import type { Command } from 'commander';
import type {
  ProbeEvent,
  SessionConfig,
  BrowserConfig,
  LogCollectorConfig,
  NetworkConfig,
  DebugSession,
  CorrelationGroup,
} from '@probe/core';
import {
  DEFAULT_BROWSER_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_CORRELATION_CONFIG,
  DEFAULT_CAPTURE_CONFIG,
  generateSessionId,
  nowMs,
} from '@probe/core';
import { loadConfig } from '../utils/config.js';
import { printBanner, formatSummary } from '../utils/output.js';

interface CaptureOptions {
  headless: boolean;
  screenshotInterval: string;
  timeout: string;
  output: string;
  format: string;
  logFile?: string;
  docker?: string;
  browser: boolean;
  proxyPort: string;
  config: string;
  verbose?: boolean;
}

export function registerCaptureCommand(program: Command): void {
  program
    .command('capture [url]')
    .description('Capture a full debug session (browser, logs, network)')
    .option('--headless', 'run browser headlessly', false)
    .option('--screenshot-interval <ms>', 'periodic screenshot interval (0=disabled)', '0')
    .option('--timeout <seconds>', 'max capture duration', '300')
    .option('--output <path>', 'output directory', '.probe-data')
    .option('--format <format>', 'report format: html, json, markdown', 'html')
    .option('--log-file <path>', 'attach log file source')
    .option('--docker <containerId>', 'attach Docker container logs')
    .option('--no-browser', 'skip browser capture (logs/network only)')
    .option('--proxy-port <port>', 'proxy port for network capture', '8080')
    .action(async (url: string | undefined, opts: CaptureOptions) => {
      await runCapture(url, opts);
    });
}

async function runCapture(url: string | undefined, opts: CaptureOptions): Promise<void> {
  printBanner();

  const config = loadConfig(opts.config);
  const sessionId = generateSessionId();
  const targetUrl = url ?? config.session.browser?.targetUrl ?? 'http://localhost:3000';
  const timeoutMs = parseInt(opts.timeout, 10) * 1000;
  const screenshotInterval = parseInt(opts.screenshotInterval, 10);
  const proxyPort = parseInt(opts.proxyPort, 10);

  // Build session config from CLI options
  const sessionConfig: SessionConfig = {
    browser: opts.browser
      ? {
          ...DEFAULT_BROWSER_CONFIG,
          ...config.session.browser,
          targetUrl,
          headless: opts.headless,
          screenshotInterval: screenshotInterval || undefined,
        }
      : undefined,
    network: {
      ...DEFAULT_NETWORK_CONFIG,
      ...config.session.network,
      proxyPort,
    },
    logs: buildLogConfigs(opts, config.session.logs),
    correlation: {
      ...DEFAULT_CORRELATION_CONFIG,
      ...config.session.correlation,
    },
    capture: {
      ...DEFAULT_CAPTURE_CONFIG,
      ...config.session.capture,
    },
  };

  const session: DebugSession = {
    id: sessionId,
    name: `capture-${sessionId.slice(0, 8)}`,
    status: 'capturing',
    config: sessionConfig,
    startedAt: nowMs(),
    eventCount: 0,
  };

  const collectedEvents: ProbeEvent[] = [];
  let spinner: { text: string; succeed: (t: string) => void; fail: (t: string) => void; stop: () => void } | undefined;

  try {
    const ora = (await import('ora')).default;
    const chalk = (await import('chalk')).default;

    spinner = ora('Initializing capture session...').start();

    // --- Initialize components ---
    // Browser agent
    let browserAgent: { close: () => Promise<void>; onEvent: (h: (e: ProbeEvent) => void) => () => void } | undefined;
    if (sessionConfig.browser?.enabled !== false && opts.browser) {
      spinner.text = 'Launching browser agent...';
      // Lazy-load browser agent to keep CLI startup fast
      const { getBrowserAgent } = await import('@probe/browser-agent');
      const agent = getBrowserAgent();
      await agent.launch(sessionConfig.browser as BrowserConfig);
      agent.onEvent((event) => collectedEvents.push(event));
      browserAgent = agent;
    }

    // Log collector
    const logDisposers: Array<() => Promise<void>> = [];
    if (sessionConfig.logs && sessionConfig.logs.length > 0) {
      spinner.text = 'Connecting log sources...';
      const { createLogSource } = await import('@probe/log-collector');
      for (const logConfig of sessionConfig.logs) {
        const source = createLogSource(logConfig);
        source.onLog((event: ProbeEvent) => collectedEvents.push(event));
        await source.connect(logConfig);
        logDisposers.push(() => source.disconnect());
      }
    }

    // Network interceptor
    let networkCapture: { stop: () => Promise<void> } | undefined;
    if (sessionConfig.network?.enabled !== false) {
      spinner.text = 'Starting network interceptor...';
      const { createNetworkCapture } = await import('@probe/network-interceptor');
      const netCapture = createNetworkCapture(sessionConfig.network as NetworkConfig);
      await netCapture.start(sessionConfig.network as NetworkConfig);
      netCapture.onRequest((event) => collectedEvents.push(event));
      netCapture.onResponse((event) => collectedEvents.push(event));
      networkCapture = netCapture;
    }

    // Correlation engine
    spinner.text = 'Initializing correlation engine...';
    const { createCorrelator } = await import('@probe/correlation-engine');
    const correlator = createCorrelator(sessionConfig.correlation ?? DEFAULT_CORRELATION_CONFIG);

    spinner.text = chalk.green(`Capturing... (${opts.timeout}s timeout, Ctrl+C to stop)`);

    // --- Main capture loop ---
    let stopped = false;

    const cleanup = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;

      if (spinner) spinner.text = 'Stopping capture...';

      // Stop all sources
      if (browserAgent) await browserAgent.close().catch(() => {});
      for (const dispose of logDisposers) await dispose().catch(() => {});
      if (networkCapture) await networkCapture.stop().catch(() => {});

      // Feed all events to correlator
      for (const event of collectedEvents) {
        correlator.ingest(event);
      }

      const timeline = correlator.buildTimeline();
      const groups: CorrelationGroup[] = correlator.getGroups();

      // Generate report
      spinner!.text = 'Generating report...';
      const { createReporter } = await import('@probe/reporter');
      const reporter = createReporter(opts.format as 'html' | 'json' | 'markdown');

      session.endedAt = nowMs();
      session.status = 'completed';
      session.eventCount = collectedEvents.length;

      const reportContent = await reporter.generate(
        { session, timeline, correlationGroups: groups },
        { includeScreenshots: true, includeRequestBodies: true },
      );

      // Save output
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { join } = await import('node:path');

      await mkdir(opts.output, { recursive: true });

      const reportExt = reporter.getFileExtension();
      const reportPath = join(opts.output, `${session.name}.${reportExt}`);
      await writeFile(reportPath, reportContent, 'utf-8');

      // Save raw session JSON
      const sessionPath = join(opts.output, `${session.name}.session.json`);
      await writeFile(
        sessionPath,
        JSON.stringify({ session, events: collectedEvents }, null, 2),
        'utf-8',
      );

      spinner!.succeed('Capture complete!');
      console.log(formatSummary(session, timeline));
      console.log(chalk.dim(`  Report: ${reportPath}`));
      console.log(chalk.dim(`  Session: ${sessionPath}`));
    };

    // Handle SIGINT gracefully
    const sigintHandler = (): void => {
      void cleanup().then(() => process.exit(0));
    };
    process.on('SIGINT', sigintHandler);

    // Navigate browser if applicable
    if (browserAgent && sessionConfig.browser) {
      const { navigate } = browserAgent as { navigate: (url: string) => Promise<void>; close: () => Promise<void>; onEvent: (h: (e: ProbeEvent) => void) => () => void };
      await navigate(targetUrl);
    }

    // Wait for timeout or SIGINT
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        resolve();
      }, timeoutMs);

      // If already stopped (SIGINT), clear timer
      const check = setInterval(() => {
        if (stopped) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 500);
    });

    if (!stopped) {
      await cleanup();
    }
  } catch (error) {
    spinner?.fail(`Capture failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function buildLogConfigs(
  opts: CaptureOptions,
  existing?: LogCollectorConfig[],
): LogCollectorConfig[] {
  const configs: LogCollectorConfig[] = existing ? [...existing] : [];

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

  return configs;
}
