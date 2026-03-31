// ============================================================
// CLI report command — Tests for command registration and options
// ============================================================

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerReportCommand } from '../../src/commands/report.js';

describe('registerReportCommand', () => {
  it('registers a report command', () => {
    const program = new Command();
    registerReportCommand(program);

    const cmd = program.commands.find(c => c.name() === 'report');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('report');
  });

  it('requires a session-file argument', () => {
    const program = new Command();
    registerReportCommand(program);

    const cmd = program.commands.find(c => c.name() === 'report')!;
    const args = cmd.registeredArguments ?? (cmd as any)._args;
    expect(args.length).toBeGreaterThanOrEqual(1);
    expect(args[0].required).toBe(true);
  });

  it('has format, output, include-screenshots, include-bodies options', () => {
    const program = new Command();
    registerReportCommand(program);

    const cmd = program.commands.find(c => c.name() === 'report')!;
    const optionNames = cmd.options.map(o => o.long?.replace('--', ''));

    expect(optionNames).toContain('format');
    expect(optionNames).toContain('output');
    expect(optionNames).toContain('include-screenshots');
    expect(optionNames).toContain('include-bodies');
  });

  it('format defaults to html', () => {
    const program = new Command();
    registerReportCommand(program);

    const cmd = program.commands.find(c => c.name() === 'report')!;
    const formatOpt = cmd.options.find(o => o.long === '--format');
    expect(formatOpt?.defaultValue).toBe('html');
  });

  it('include-screenshots defaults to true', () => {
    const program = new Command();
    registerReportCommand(program);

    const cmd = program.commands.find(c => c.name() === 'report')!;
    const opt = cmd.options.find(o => o.long === '--include-screenshots');
    expect(opt?.defaultValue).toBe(true);
  });

  it('include-bodies defaults to false', () => {
    const program = new Command();
    registerReportCommand(program);

    const cmd = program.commands.find(c => c.name() === 'report')!;
    const opt = cmd.options.find(o => o.long === '--include-bodies');
    expect(opt?.defaultValue).toBe(false);
  });
});
