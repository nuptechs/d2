// ============================================================
// DB Query Interceptor — Wraps pg Pool.query for capture
// Emits SdkDbQueryEvent with timing, row counts, errors
// ============================================================

import type { SdkConfig, SdkDbQueryEvent } from '@probe/core';
import { nowMs, isSensitiveKey } from '@probe/core';
import { getCurrentRequestId, getCurrentCorrelationId } from './context.js';
import { SdkEventCollector } from './event-collector.js';

const MAX_QUERY_LENGTH = 1000;

export interface DbQueryInterceptor {
  readonly collector: SdkEventCollector;
  readonly config: SdkConfig;
}

/**
 * Create a DB query interceptor that emits events for each query.
 */
export function createDbQueryInterceptor(
  config: SdkConfig,
  collector?: SdkEventCollector,
): DbQueryInterceptor {
  return {
    collector: collector ?? new SdkEventCollector(),
    config,
  };
}

/**
 * Wrap a pg-compatible Pool to intercept query calls.
 * Monkey-patches pool.query to capture timing and emit events.
 * Returns the same pool instance (mutated).
 */
export function wrapPgPool<T extends { query: (...args: unknown[]) => unknown }>(
  pool: T,
  interceptor: DbQueryInterceptor,
): T {
  if (!interceptor.config.enabled || !interceptor.config.captureDbQueries) {
    return pool;
  }

  const originalQuery = pool.query.bind(pool);

  pool.query = async function probeWrappedQuery(...args: unknown[]): Promise<unknown> {
    const startTime = nowMs();
    const queryText = extractQueryText(args);
    const params = extractParams(args);

    try {
      const result = await (originalQuery as (...a: unknown[]) => Promise<unknown>)(...args);
      const duration = nowMs() - startTime;

      emitQueryEvent(interceptor, {
        query: truncateQuery(queryText),
        params: redactParams(params, interceptor.config.redactPatterns),
        duration,
        rowCount: extractRowCount(result),
      });

      return result;
    } catch (err) {
      const duration = nowMs() - startTime;

      emitQueryEvent(interceptor, {
        query: truncateQuery(queryText),
        params: redactParams(params, interceptor.config.redactPatterns),
        duration,
        error: err instanceof Error ? err.message : String(err),
      });

      throw err;
    }
  } as T['query'];

  return pool;
}

/** Normalize a query by replacing literal values with placeholders */
export function normalizeQuery(query: string): string {
  // Replace string literals
  let normalized = query.replace(/'[^']*'/g, '$?');
  // Replace numeric literals (but not $1-style params)
  normalized = normalized.replace(/\b\d+\.?\d*\b/g, (match, offset: number) => {
    // Keep $N param references
    if (offset > 0 && normalized[offset - 1] === '$') return match;
    return '$?';
  });
  return normalized;
}

// ---- Internal helpers ----

function emitQueryEvent(
  interceptor: DbQueryInterceptor,
  data: {
    query: string;
    params?: unknown[];
    duration: number;
    rowCount?: number;
    error?: string;
  },
): void {
  interceptor.collector.emit({
    type: 'db-query' as const,
    correlationId: getCurrentCorrelationId(),
    query: data.query,
    params: data.params,
    duration: data.duration,
    rowCount: data.rowCount,
    error: data.error,
    requestId: getCurrentRequestId(),
  } satisfies Omit<SdkDbQueryEvent, 'id' | 'sessionId' | 'timestamp' | 'source'>);
}

function extractQueryText(args: unknown[]): string {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object' && 'text' in first) {
    return String((first as { text: unknown }).text);
  }
  return '[unknown query]';
}

function extractParams(args: unknown[]): unknown[] | undefined {
  const first = args[0];
  if (typeof first === 'string' && Array.isArray(args[1])) {
    return args[1] as unknown[];
  }
  if (first && typeof first === 'object' && 'values' in first) {
    const values = (first as { values: unknown }).values;
    return Array.isArray(values) ? values : undefined;
  }
  return undefined;
}

function extractRowCount(result: unknown): number | undefined {
  if (result && typeof result === 'object') {
    if ('rowCount' in result && typeof (result as { rowCount: unknown }).rowCount === 'number') {
      return (result as { rowCount: number }).rowCount;
    }
    if ('rows' in result && Array.isArray((result as { rows: unknown }).rows)) {
      return (result as { rows: unknown[] }).rows.length;
    }
  }
  return undefined;
}

function truncateQuery(query: string): string {
  if (query.length <= MAX_QUERY_LENGTH) return query;
  return query.slice(0, MAX_QUERY_LENGTH) + '... [truncated]';
}

function redactParams(
  params: unknown[] | undefined,
  redactPatterns?: string[],
): unknown[] | undefined {
  if (!params || !redactPatterns || redactPatterns.length === 0) return params;

  return params.map((param) => {
    if (typeof param === 'string') {
      for (const pattern of redactPatterns) {
        if (isSensitiveKey(pattern)) {
          // Can't know the key here, just check if value looks like a known pattern
        }
      }
    }
    return param;
  });
}
