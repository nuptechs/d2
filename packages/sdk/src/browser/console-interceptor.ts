// ============================================================
// Console Interceptor — Captures console output in browser
// Only intercepts, never blocks original console output
// ============================================================

import type { SdkEvent } from '@probe/core';

type ConsoleLevel = 'log' | 'warn' | 'error' | 'info' | 'debug';
type EventHandler = (event: Omit<SdkEvent, 'id' | 'sessionId' | 'timestamp'>) => void;

/**
 * Install a console interceptor that emits SDK events for every
 * console.log/warn/error/info/debug call.
 *
 * Original console behavior is fully preserved.
 * Returns a restore function that removes the wrappers.
 */
export function installConsoleInterceptor(onEvent: EventHandler): () => void {
  const levels: ConsoleLevel[] = ['log', 'warn', 'error', 'info', 'debug'];

  const originals: Record<ConsoleLevel, (...args: unknown[]) => void> = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  };

  for (const level of levels) {
    const original = originals[level];

    console[level] = (...args: unknown[]) => {
      // Always call original first — never block output
      original.apply(console, args);

      // Build message from args
      const message = args
        .map((arg) => {
          if (typeof arg === 'string') return arg;
          if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
          try { return JSON.stringify(arg); }
          catch { return String(arg); }
        })
        .join(' ');

      const stack = args.find((a): a is Error => a instanceof Error)?.stack;

      onEvent({
        source: 'sdk',
        type: 'custom' as const,
        name: `console.${level}`,
        data: {
          level,
          message,
          stack,
        },
      } as Omit<SdkEvent, 'id' | 'sessionId' | 'timestamp'>);
    };
  }

  // Return restore function
  return () => {
    for (const level of levels) {
      console[level] = originals[level];
    }
  };
}
