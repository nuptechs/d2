// ============================================================
// Error Boundary — Captures uncaught errors & rejections
// Listens to window error and unhandledrejection events
// ============================================================

import type { SdkEvent } from '@probe/core';

type EventHandler = (event: Omit<SdkEvent, 'id' | 'sessionId' | 'timestamp'>) => void;

interface DedupEntry {
  message: string;
  timestamp: number;
}

const DEDUP_WINDOW_MS = 1000;

/**
 * Install global error boundary that captures:
 * - Uncaught errors (window 'error' event)
 * - Unhandled promise rejections (window 'unhandledrejection' event)
 *
 * Prevents double-reporting via message+timestamp deduplication.
 * Returns a cleanup function that removes all listeners.
 */
export function installErrorBoundary(onEvent: EventHandler): () => void {
  const recentErrors: DedupEntry[] = [];

  function isDuplicate(message: string): boolean {
    const now = Date.now();
    // Prune old entries
    while (recentErrors.length > 0 && now - (recentErrors[0]?.timestamp ?? 0) > DEDUP_WINDOW_MS) {
      recentErrors.shift();
    }
    // Check for duplicate
    const found = recentErrors.some((e) => e.message === message);
    if (!found) {
      recentErrors.push({ message, timestamp: now });
    }
    return found;
  }

  function handleError(event: ErrorEvent): void {
    const message = event.error?.message ?? event.message ?? 'Unknown error';
    if (isDuplicate(message)) return;

    const error = event.error instanceof Error ? event.error : null;

    onEvent({
      source: 'sdk',
      type: 'custom' as const,
      name: 'uncaught-error',
      data: {
        errorType: 'uncaught',
        message,
        stack: error?.stack,
        fileName: event.filename ?? error?.stack?.split('\n')[1],
        lineNumber: event.lineno,
        columnNumber: event.colno,
      },
    } as Omit<SdkEvent, 'id' | 'sessionId' | 'timestamp'>);
  }

  function handleRejection(event: PromiseRejectionEvent): void {
    const reason = event.reason;
    const message = reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : 'Unhandled promise rejection';

    if (isDuplicate(message)) return;

    onEvent({
      source: 'sdk',
      type: 'custom' as const,
      name: 'unhandled-rejection',
      data: {
        errorType: 'unhandled-rejection',
        message,
        stack: reason instanceof Error ? reason.stack : undefined,
      },
    } as Omit<SdkEvent, 'id' | 'sessionId' | 'timestamp'>);
  }

  window.addEventListener('error', handleError);
  window.addEventListener('unhandledrejection', handleRejection);

  // Return cleanup function
  return () => {
    window.removeEventListener('error', handleError);
    window.removeEventListener('unhandledrejection', handleRejection);
    recentErrors.length = 0;
  };
}
