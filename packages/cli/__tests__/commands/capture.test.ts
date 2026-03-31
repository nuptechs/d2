// ============================================================
// CLI capture command — Tests for option registration and
// command structure (integration is tested by E2E)
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerCaptureCommand } from '../../src/commands/capture.js';

describe('registerCaptureCommand', () => {
  it('registers a capture command on the program', () => {
    const program = new Command();
    registerCaptureCommand(program);

    const cmd = program.commands.find(c => c.name() === 'capture');
    expect(cmd).toBeDefined();
  });

  it('capture command accepts a url argument', () => {
    const program = new Command();
    registerCaptureCommand(program);

    const cmd = program.commands.find(c => c.name() === 'capture')!;
    // Commander stores positional args in registeredArguments (or _args)
    const args = cmd.registeredArguments ?? (cmd as any)._args;
    expect(args).toBeDefined();
    expect(args.length).toBeGreaterThanOrEqual(1);
  });

  it('has expected options', () => {
    const program = new Command();
    registerCaptureCommand(program);

    const cmd = program.commands.find(c => c.name() === 'capture')!;
    const optionNames = cmd.options.map(o => o.long?.replace('--', '') ?? o.short);

    expect(optionNames).toContain('headless');
    expect(optionNames).toContain('screenshot-interval');
    expect(optionNames).toContain('timeout');
    expect(optionNames).toContain('output');
    expect(optionNames).toContain('format');
    expect(optionNames).toContain('log-file');
    expect(optionNames).toContain('docker');
    expect(optionNames).toContain('proxy-port');
  });

  it('has correct defaults for options', () => {
    const program = new Command();
    registerCaptureCommand(program);

    const cmd = program.commands.find(c => c.name() === 'capture')!;

    const getDefault = (name: string) => {
      const opt = cmd.options.find(o => o.long === `--${name}`);
      return opt?.defaultValue;
    };

    expect(getDefault('timeout')).toBe('300');
    expect(getDefault('output')).toBe('.probe-data');
    expect(getDefault('format')).toBe('html');
    expect(getDefault('proxy-port')).toBe('8080');
    expect(getDefault('screenshot-interval')).toBe('0');
  });

  it('has a description', () => {
    const program = new Command();
    registerCaptureCommand(program);

    const cmd = program.commands.find(c => c.name() === 'capture')!;
    expect(cmd.description()).toContain('Capture');
  });
});
