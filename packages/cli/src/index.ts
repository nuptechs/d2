#!/usr/bin/env node
// ============================================================
// @probe/cli — Debug Probe Command-Line Interface
// ============================================================

import { Command } from 'commander';
import { registerCaptureCommand } from './commands/capture.js';
import { registerWatchCommand } from './commands/watch.js';
import { registerReportCommand } from './commands/report.js';
import { registerReplayCommand } from './commands/replay.js';

const program = new Command();

program
  .name('probe')
  .version('0.1.0')
  .description('Debug Probe — capture, correlate, and visualize debug sessions')
  .option('--config <path>', 'path to config file', '.proberc.json')
  .option('--verbose', 'enable verbose output');

registerCaptureCommand(program);
registerWatchCommand(program);
registerReportCommand(program);
registerReplayCommand(program);

program.parse();
