// ============================================================
// Async Context Propagation — AsyncLocalStorage-based
// Propagates probe context through async call chains
// ============================================================

import { AsyncLocalStorage } from 'node:async_hooks';

/** Context attached to each request for correlation */
export interface ProbeContext {
  readonly correlationId: string;
  readonly requestId: string;
  readonly sessionId: string;
}

/** Global async local storage instance for probe context */
export const probeStorage = new AsyncLocalStorage<ProbeContext>();

/** Run a function within a probe context */
export function runWithContext<T>(context: ProbeContext, fn: () => T): T {
  return probeStorage.run(context, fn);
}

/** Get the current probe context (if any) */
export function getCurrentContext(): ProbeContext | undefined {
  return probeStorage.getStore();
}

/** Get the current request ID from async context */
export function getCurrentRequestId(): string | undefined {
  return probeStorage.getStore()?.requestId;
}

/** Get the current correlation ID from async context */
export function getCurrentCorrelationId(): string | undefined {
  return probeStorage.getStore()?.correlationId;
}
