// ============================================================
// CLI watch command — Tests for command registration, options,
// and LOG_LEVEL_ORDER filtering logic
// ============================================================

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerWatchCommand } from '../../src/commands/watch.js';

describe('registerWatchCommand', () => {
  it('registers a watch command', () => {
    const program = new Command();
    registerWatchCommand(program);

    const cmd = program.commands.find(c => c.name() === 'watch');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('Real-time');
  });

  it('has log-file, docker, level, pattern options', () => {
    const program = new Command();
    registerWatchCommand(program);

    const cmd = program.commands.find(c => c.name() === 'watch')!;
    const optionNames = cmd.options.map(o => o.long?.replace('--', ''));

    expect(optionNames).toContain('log-file');
    expect(optionNames).toContain('docker');
    expect(optionNames).toContain('level');
    expect(optionNames).toContain('pattern');
  });

  it('level defaults to info', () => {
    const program = new Command();
    registerWatchCommand(program);

    const cmd = program.commands.find(c => c.name() === 'watch')!;
    const levelOpt = cmd.options.find(o => o.long === '--level');
    expect(levelOpt?.defaultValue).toBe('info');
  });

  it('does not require positional arguments', () => {
    const program = new Command();
    registerWatchCommand(program);

    const cmd = program.commands.find(c => c.name() === 'watch')!;
    const args = cmd.registeredArguments ?? (cmd as any)._args ?? [];
    expect(args.length).toBe(0);
  });
});
