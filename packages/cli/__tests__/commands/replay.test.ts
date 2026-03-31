// ============================================================
// CLI replay command — Tests for command registration,
// formatRelativeTime, and event sorting/filtering logic
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerReplayCommand } from '../../src/commands/replay.js';

describe('registerReplayCommand', () => {
  it('registers a replay command', () => {
    const program = new Command();
    registerReplayCommand(program);

    const cmd = program.commands.find(c => c.name() === 'replay');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('Replay');
  });

  it('requires a session-file argument', () => {
    const program = new Command();
    registerReplayCommand(program);

    const cmd = program.commands.find(c => c.name() === 'replay')!;
    const args = cmd.registeredArguments ?? (cmd as any)._args;
    expect(args.length).toBeGreaterThanOrEqual(1);
    expect(args[0].required).toBe(true);
  });

  it('has speed and filter options', () => {
    const program = new Command();
    registerReplayCommand(program);

    const cmd = program.commands.find(c => c.name() === 'replay')!;
    const optionNames = cmd.options.map(o => o.long?.replace('--', ''));

    expect(optionNames).toContain('speed');
    expect(optionNames).toContain('filter');
  });

  it('speed defaults to 0 (instant)', () => {
    const program = new Command();
    registerReplayCommand(program);

    const cmd = program.commands.find(c => c.name() === 'replay')!;
    const speedOpt = cmd.options.find(o => o.long === '--speed');
    expect(speedOpt?.defaultValue).toBe('0');
  });
});
