// ============================================================
// Request Tracer — Manages request lifecycle events
// Tracks active requests with timeout protection
// ============================================================

import type { SdkEvent, SdkRequestStartEvent, SdkRequestEndEvent } from '@probe/core';
import {
  generateRequestId,
  generateCorrelationId,
  nowMs,
  redactHeaders,
} from '@probe/core';
import { SdkEventCollector } from './event-collector.js';

const REQUEST_TIMEOUT_MS = 60_000;

type EventHandler = (event: SdkEvent) => void;

interface ActiveRequest {
  readonly requestId: string;
  readonly correlationId: string;
  readonly startTime: number;
}

export class RequestTracer {
  private readonly collector: SdkEventCollector;
  private readonly activeRequests = new Map<string, ActiveRequest>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(collector?: SdkEventCollector) {
    this.collector = collector ?? new SdkEventCollector();
    this.startCleanupTimer();
  }

  /** Start tracking a new request */
  startRequest(
    method: string,
    url: string,
    headers?: Record<string, string>,
    sensitiveHeaders?: string[],
  ): { requestId: string; correlationId: string } {
    const requestId = generateRequestId();
    const correlationId = generateCorrelationId();
    const startTime = nowMs();

    this.activeRequests.set(requestId, { requestId, correlationId, startTime });

    this.collector.emit({
      type: 'request-start' as const,
      requestId,
      correlationId,
      method,
      url,
      headers: headers ? redactHeaders(headers, sensitiveHeaders) : {},
    } satisfies Omit<SdkRequestStartEvent, 'id' | 'sessionId' | 'timestamp' | 'source'>);

    return { requestId, correlationId };
  }

  /** End tracking a request */
  endRequest(requestId: string, statusCode: number, error?: string): void {
    const active = this.activeRequests.get(requestId);
    if (!active) return;

    this.activeRequests.delete(requestId);
    const duration = nowMs() - active.startTime;

    this.collector.emit({
      type: 'request-end' as const,
      requestId,
      correlationId: active.correlationId,
      statusCode,
      duration,
      error,
    } satisfies Omit<SdkRequestEndEvent, 'id' | 'sessionId' | 'timestamp' | 'source'>);
  }

  /** Register an event handler (delegates to collector) */
  onEvent(handler: EventHandler): () => void {
    return this.collector.onEvent(handler);
  }

  /** Get count of currently active requests */
  getActiveCount(): number {
    return this.activeRequests.size;
  }

  /** Stop the cleanup timer */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.activeRequests.clear();
  }

  /** Auto-close requests that exceed the timeout */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      const now = nowMs();
      for (const [requestId, active] of this.activeRequests) {
        if (now - active.startTime > REQUEST_TIMEOUT_MS) {
          this.endRequest(requestId, 0, 'Request timed out (probe cleanup)');
        }
      }
    }, 15_000);

    // Unref so the timer doesn't keep the process alive
    if (this.cleanupTimer != null) {
      const timer = this.cleanupTimer;
      if (typeof timer === 'object' && 'unref' in timer) {
        (timer as { unref: () => void }).unref();
      }
    }
  }
}
