// ============================================================
// MongoDB Interceptor — Patches Collection.prototype methods
// Emits SdkDbQueryEvent with timing, document counts, errors
// ============================================================

import type { SdkDbQueryEvent } from '@probe/core';
import { nowMs } from '@probe/core';
import { getCurrentRequestId, getCurrentCorrelationId } from './context.js';

export interface MongoInterceptorConfig {
  emitEvent: (event: Omit<SdkDbQueryEvent, 'id' | 'sessionId' | 'timestamp' | 'source'>) => void;
  sessionId: string;
  redactParams?: boolean; // default true
}

const PATCHED_METHODS = [
  'findOne',
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'aggregate',
] as const;

/** WeakMap storing original prototype methods per client */
const originals = new WeakMap<
  object,
  {
    collectionProto: any;
    methods: Record<string, Function>;
    find: Function;
  }
>();

/**
 * Wrap a MongoDB client by patching Collection.prototype methods.
 * All collections created from this client will automatically be intercepted.
 * Returns the same client instance.
 */
export function wrapMongoClient(client: any, config: MongoInterceptorConfig): any {
  // Access the Collection prototype from the client's db method
  // MongoClient → db() → collection() → Collection.prototype
  const db = client.db?.();
  if (!db) return client;

  // Get Collection prototype without creating a named collection reference
  // db.collection() in MongoDB drivers may register the name internally
  const collectionFn = db.collection;
  if (typeof collectionFn !== 'function') return client;

  // Access Collection.prototype via the constructor on the db's prototype chain
  let collectionProto: any;
  try {
    // Attempt to get the prototype from an existing built-in collection
    // 'admin' always exists and won't pollute the user's namespace
    const sample = collectionFn.call(db, 'admin');
    collectionProto = sample ? Object.getPrototypeOf(sample) : null;
  } catch {
    return client; // can't get prototype — bail silently
  }
  if (!collectionProto || originals.has(client)) return client;

  const redact = config.redactParams !== false; // default true

  const savedMethods: Record<string, Function> = {};
  const savedFind = collectionProto.find;

  // Patch standard methods (return promises)
  for (const method of PATCHED_METHODS) {
    if (typeof collectionProto[method] !== 'function') continue;

    savedMethods[method] = collectionProto[method];
    const originalMethod = collectionProto[method];

    collectionProto[method] = function probeWrappedMongoOp(this: any, ...args: unknown[]): unknown {
      const collectionName = this.collectionName ?? this.s?.namespace?.collection ?? '[unknown]';
      const startTime = nowMs();
      const filter = extractFilter(method, args);

      try {
        const result = originalMethod.apply(this, args);

        if (result && typeof result.then === 'function') {
          return result.then(
            (res: unknown) => {
              emitMongoEvent(config, {
                operation: method,
                collection: collectionName,
                duration: nowMs() - startTime,
                documentCount: extractDocumentCount(method, args, res),
                filter: redact ? redactFilter(filter) : filter,
              });
              return res;
            },
            (err: unknown) => {
              emitMongoEvent(config, {
                operation: method,
                collection: collectionName,
                duration: nowMs() - startTime,
                filter: redact ? redactFilter(filter) : filter,
                error: err instanceof Error ? err.message : String(err),
              });
              throw err;
            },
          );
        }

        return result;
      } catch (err) {
        emitMongoEvent(config, {
          operation: method,
          collection: collectionName,
          duration: nowMs() - startTime,
          filter: redact ? redactFilter(filter) : filter,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };
  }

  // Patch find() — returns a cursor, not a promise
  if (typeof collectionProto.find === 'function') {
    collectionProto.find = function probeWrappedFind(this: any, ...args: unknown[]): unknown {
      const collectionName = this.collectionName ?? this.s?.namespace?.collection ?? '[unknown]';
      const filter = args[0] && typeof args[0] === 'object' ? args[0] : undefined;
      const cursor = savedFind.apply(this, args);

      if (!cursor) return cursor;

      // Wrap toArray
      if (typeof cursor.toArray === 'function') {
        const originalToArray = cursor.toArray.bind(cursor);
        cursor.toArray = function probeWrappedToArray(...toArrayArgs: unknown[]): unknown {
          const startTime = nowMs();
          const result = originalToArray(...toArrayArgs);
          if (result && typeof result.then === 'function') {
            return result.then(
              (docs: unknown) => {
                emitMongoEvent(config, {
                  operation: 'find',
                  collection: collectionName,
                  duration: nowMs() - startTime,
                  documentCount: Array.isArray(docs) ? docs.length : undefined,
                  filter: redact ? redactFilter(filter) : filter,
                });
                return docs;
              },
              (err: unknown) => {
                emitMongoEvent(config, {
                  operation: 'find',
                  collection: collectionName,
                  duration: nowMs() - startTime,
                  filter: redact ? redactFilter(filter) : filter,
                  error: err instanceof Error ? err.message : String(err),
                });
                throw err;
              },
            );
          }
          return result;
        };
      }

      // Wrap next
      if (typeof cursor.next === 'function') {
        const originalNext = cursor.next.bind(cursor);
        cursor.next = function probeWrappedNext(...nextArgs: unknown[]): unknown {
          const startTime = nowMs();
          const result = originalNext(...nextArgs);
          if (result && typeof result.then === 'function') {
            return result.then(
              (doc: unknown) => {
                emitMongoEvent(config, {
                  operation: 'find.next',
                  collection: collectionName,
                  duration: nowMs() - startTime,
                  documentCount: doc ? 1 : 0,
                  filter: redact ? redactFilter(filter) : filter,
                });
                return doc;
              },
              (err: unknown) => {
                emitMongoEvent(config, {
                  operation: 'find.next',
                  collection: collectionName,
                  duration: nowMs() - startTime,
                  filter: redact ? redactFilter(filter) : filter,
                  error: err instanceof Error ? err.message : String(err),
                });
                throw err;
              },
            );
          }
          return result;
        };
      }

      // Wrap forEach
      if (typeof cursor.forEach === 'function') {
        const originalForEach = cursor.forEach.bind(cursor);
        cursor.forEach = function probeWrappedForEach(iteratee: Function, ...rest: unknown[]): unknown {
          const startTime = nowMs();
          let count = 0;
          const countingIteratee = (doc: unknown) => {
            count++;
            return iteratee(doc);
          };
          const result = originalForEach(countingIteratee, ...rest);
          if (result && typeof result.then === 'function') {
            return result.then(
              (res: unknown) => {
                emitMongoEvent(config, {
                  operation: 'find.forEach',
                  collection: collectionName,
                  duration: nowMs() - startTime,
                  documentCount: count,
                  filter: redact ? redactFilter(filter) : filter,
                });
                return res;
              },
              (err: unknown) => {
                emitMongoEvent(config, {
                  operation: 'find.forEach',
                  collection: collectionName,
                  duration: nowMs() - startTime,
                  documentCount: count,
                  filter: redact ? redactFilter(filter) : filter,
                  error: err instanceof Error ? err.message : String(err),
                });
                throw err;
              },
            );
          }
          return result;
        };
      }

      return cursor;
    };
  }

  originals.set(client, { collectionProto, methods: savedMethods, find: savedFind });
  return client;
}

/**
 * Remove instrumentation from a MongoDB client, restoring original prototype methods.
 */
export function unwrapMongoClient(client: any): void {
  const saved = originals.get(client);
  if (!saved) return;

  const proto = saved.collectionProto;
  for (const [method, fn] of Object.entries(saved.methods)) {
    proto[method] = fn;
  }
  proto.find = saved.find;

  originals.delete(client);
}

// ---- Internal helpers ----

function emitMongoEvent(
  config: MongoInterceptorConfig,
  data: {
    operation: string;
    collection: string;
    duration: number;
    documentCount?: number;
    filter?: unknown;
    error?: string;
  },
): void {
  config.emitEvent({
    type: 'db-query' as const,
    correlationId: getCurrentCorrelationId() ?? '',
    query: `${data.operation} on ${data.collection}`,
    duration: data.duration,
    rowCount: data.documentCount,
    error: data.error,
    requestId: getCurrentRequestId(),
    // Additional metadata stored as extra fields
    database: 'mongodb',
    operation: data.operation,
    collection: data.collection,
    documentCount: data.documentCount,
    filter: data.filter,
  } as any);
}

function extractFilter(method: string, args: unknown[]): unknown {
  switch (method) {
    case 'findOne':
    case 'updateOne':
    case 'updateMany':
    case 'deleteOne':
    case 'deleteMany':
      return args[0] && typeof args[0] === 'object' ? args[0] : undefined;
    case 'aggregate':
      return Array.isArray(args[0]) ? args[0] : undefined;
    case 'insertOne':
    case 'insertMany':
      return undefined; // No filter for inserts
    default:
      return undefined;
  }
}

function extractDocumentCount(method: string, args: unknown[], result: unknown): number | undefined {
  switch (method) {
    case 'insertOne':
      return result && typeof result === 'object' && 'acknowledged' in result ? 1 : undefined;
    case 'insertMany':
      if (Array.isArray(args[0])) return args[0].length;
      return undefined;
    case 'findOne':
      return result ? 1 : 0;
    case 'updateOne':
    case 'updateMany':
      if (result && typeof result === 'object' && 'modifiedCount' in result) {
        return (result as { modifiedCount: number }).modifiedCount;
      }
      return undefined;
    case 'deleteOne':
    case 'deleteMany':
      if (result && typeof result === 'object' && 'deletedCount' in result) {
        return (result as { deletedCount: number }).deletedCount;
      }
      return undefined;
    case 'aggregate':
      return Array.isArray(result) ? result.length : undefined;
    default:
      return undefined;
  }
}

/** Recursively redact all values in a filter object, preserving structure */
function redactFilter(filter: unknown): unknown {
  if (filter === null || filter === undefined) return filter;

  if (Array.isArray(filter)) {
    return filter.map(redactFilter);
  }

  if (typeof filter === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
      if (typeof value === 'object' && value !== null) {
        redacted[key] = redactFilter(value);
      } else {
        redacted[key] = '[REDACTED]';
      }
    }
    return redacted;
  }

  return '[REDACTED]';
}
