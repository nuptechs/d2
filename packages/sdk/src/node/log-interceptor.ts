// ============================================================
// Log Interceptor — Captures console output as SDK events
// Adds secondary capture without replacing original console
// ============================================================

import type { SdkEvent } from '@probe/core';
import { redactBody } from '@probe/core';
import { getCurrentRequestId, getCurrentCorrelationId } from './context.js';
import { SdkEventCollector } from './event-collector.js';

type LogLevel = 'log' | 'warn' | 'error' | 'info' | 'debug';

const MAX_MESSAGE_LENGTH = 8_192;

export interface LogInterceptor {
  readonly collector: SdkEventCollector;
}

/**
 * Create a log interceptor that emits SDK events for console calls.
 */
export function createLogInterceptor(collector?: SdkEventCollector): LogInterceptor {
  return {
    collector: collector ?? new SdkEventCollector(),
  };
}

/**
 * Wrap console methods to capture log events.
 * Does NOT replace console output — adds secondary capture.
 * Returns a restore function that removes the wrappers.
 */
export function wrapConsole(interceptor: LogInterceptor): () => void {
  const originals: Record<LogLevel, (...args: unknown[]) => void> = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  };

  const levels: LogLevel[] = ['log', 'warn', 'error', 'info', 'debug'];

  for (const level of levels) {
    const original = originals[level];
    console[level] = (...args: unknown[]) => {
      // Always call original first — never block output
      original.apply(console, args);

      // Emit capture event
      emitLogEvent(interceptor, level, args);
    };
  }

  // Return restore function
  return () => {
    for (const level of levels) {
      console[level] = originals[level];
    }
  };
}

// ---- Internal ----

function emitLogEvent(
  interceptor: LogInterceptor,
  level: LogLevel,
  args: unknown[],
): void {
  const rawMessage = args
    .map((arg) => {
      if (typeof arg === 'string') return arg.length > MAX_MESSAGE_LENGTH ? arg.slice(0, MAX_MESSAGE_LENGTH) : arg;
      if (arg instanceof Error) return arg.message;
      try {
        const json = JSON.stringify(arg);
        return json.length > MAX_MESSAGE_LENGTH ? json.slice(0, MAX_MESSAGE_LENGTH) + '...' : json;
      }
      catch { return String(arg); }
    })
    .join(' ');

  const message = redactBody(
    rawMessage.length > MAX_MESSAGE_LENGTH
      ? rawMessage.slice(0, MAX_MESSAGE_LENGTH) + '... [truncated]'
      : rawMessage
  );

  const stack = level === 'error'
    ? args.find((a): a is Error => a instanceof Error)?.stack
    : undefined;

  interceptor.collector.emit({
    type: 'custom' as const,
    correlationId: getCurrentCorrelationId(),
    name: `console.${level}`,
    data: {
      level,
      message,
      stack,
      requestId: getCurrentRequestId(),
    },
  } as Omit<SdkEvent, 'id' | 'sessionId' | 'timestamp' | 'source'>);
}
