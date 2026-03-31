// ============================================================
// Redis Interceptor — Wraps ioredis/redis client commands
// Emits SdkCacheEvent with timing, command info, errors
// ============================================================

import type { SdkCacheEvent } from '@probe/core';
import { nowMs } from '@probe/core';
import { getCurrentRequestId, getCurrentCorrelationId } from './context.js';

export interface RedisInterceptorConfig {
  emitEvent: (event: Omit<SdkCacheEvent, 'id' | 'sessionId' | 'timestamp' | 'source'>) => void;
  sessionId: string;
}

const INTERCEPTED_COMMANDS = [
  'get', 'set', 'del',
  'hget', 'hset', 'hdel',
  'lpush', 'rpush', 'lpop', 'rpop',
  'sadd', 'srem',
  'expire', 'ttl',
  'incr', 'decr',
  'mget', 'mset',
] as const;

type RedisCommand = (typeof INTERCEPTED_COMMANDS)[number];

/** WeakMap storing original methods per client instance */
const originals = new WeakMap<object, Record<string, Function>>();

/**
 * Wrap a Redis client (ioredis or node-redis compatible) to intercept commands.
 * Monkey-patches common commands to capture timing and emit events.
 * Returns the same client instance (mutated).
 */
export function wrapRedisClient(client: any, config: RedisInterceptorConfig): any {
  if (originals.has(client)) return client; // already wrapped

  const saved: Record<string, Function> = {};

  for (const cmd of INTERCEPTED_COMMANDS) {
    if (typeof client[cmd] !== 'function') continue;

    saved[cmd] = client[cmd].bind(client);
    const originalCmd = saved[cmd]!;

    client[cmd] = function probeWrappedRedisCmd(...args: unknown[]): unknown {
      return interceptCommand(originalCmd, cmd, args, config);
    };
  }

  originals.set(client, saved);
  return client;
}

/**
 * Remove instrumentation from a Redis client, restoring original methods.
 */
export function unwrapRedisClient(client: any): void {
  const saved = originals.get(client);
  if (!saved) return;

  for (const [cmd, fn] of Object.entries(saved)) {
    client[cmd] = fn;
  }
  originals.delete(client);
}

// ---- Internal helpers ----

function interceptCommand(
  original: Function,
  command: RedisCommand,
  args: unknown[],
  config: RedisInterceptorConfig,
): unknown {
  const startTime = nowMs();
  const key = extractKey(command, args);
  const callback = extractCallback(args);

  // Callback-style
  if (callback) {
    const cbIndex = args.indexOf(callback);
    args[cbIndex] = function wrappedCallback(err: unknown, result: unknown) {
      const duration = nowMs() - startTime;
      emitRedisEvent(config, {
        command,
        key,
        duration,
        error: err instanceof Error ? err.message : err ? String(err) : undefined,
      });
      callback(err, result);
    };
    return original(...args);
  }

  // Promise-style
  try {
    const result = original(...args);

    if (result && typeof result.then === 'function') {
      return result.then(
        (res: unknown) => {
          emitRedisEvent(config, {
            command,
            key,
            duration: nowMs() - startTime,
          });
          return res;
        },
        (err: unknown) => {
          emitRedisEvent(config, {
            command,
            key,
            duration: nowMs() - startTime,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        },
      );
    }

    // Synchronous result (unlikely but safe)
    emitRedisEvent(config, {
      command,
      key,
      duration: nowMs() - startTime,
    });
    return result;
  } catch (err) {
    emitRedisEvent(config, {
      command,
      key,
      duration: nowMs() - startTime,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function emitRedisEvent(
  config: RedisInterceptorConfig,
  data: {
    command: string;
    key: string;
    duration: number;
    error?: string;
  },
): void {
  // Map Redis commands to cache-op operation types
  const operation = mapCommandToOperation(data.command);

  config.emitEvent({
    type: 'cache-op' as const,
    correlationId: getCurrentCorrelationId() ?? '',
    operation,
    key: data.key,
    duration: data.duration,
    requestId: getCurrentRequestId(),
    // Additional metadata stored as extra fields
    database: 'redis',
    command: data.command,
    error: data.error,
  } as any);
}

function mapCommandToOperation(command: string): 'get' | 'set' | 'del' | 'hit' | 'miss' {
  switch (command) {
    case 'get':
    case 'hget':
    case 'mget':
      return 'get';
    case 'set':
    case 'hset':
    case 'mset':
    case 'lpush':
    case 'rpush':
    case 'sadd':
      return 'set';
    case 'del':
    case 'hdel':
    case 'srem':
    case 'lpop':
    case 'rpop':
      return 'del';
    default:
      return 'get'; // expire, ttl, incr, decr — read-like ops
  }
}

function extractKey(command: RedisCommand, args: unknown[]): string {
  // Most commands: first arg is the key
  // mget/mset: multiple keys
  switch (command) {
    case 'mget':
      if (Array.isArray(args[0])) return (args[0] as string[]).join(', ');
      return args.filter((a) => typeof a === 'string').join(', ');
    case 'mset': {
      // mset can be called as mset(key1, val1, key2, val2, ...) or mset({key1: val1, ...})
      if (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
        return Object.keys(args[0] as object).join(', ');
      }
      // Extract every other arg as a key
      const keys: string[] = [];
      for (let i = 0; i < args.length; i += 2) {
        if (typeof args[i] === 'string') keys.push(args[i] as string);
      }
      return keys.join(', ');
    }
    default:
      return typeof args[0] === 'string' ? args[0] : '[unknown]';
  }
}

function extractCallback(args: unknown[]): Function | undefined {
  const last = args[args.length - 1];
  return typeof last === 'function' ? (last as Function) : undefined;
}
