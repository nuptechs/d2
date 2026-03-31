// ============================================================
// Batch Sender — Buffers events and POSTs them in batches
// Uses RingBuffer (bounded) + CircuitBreaker (fail-fast)
// ============================================================

import type { ProbeEvent } from '@probe/core';
import { RingBuffer } from '@probe/core/utils';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';

export interface BatchSenderConfig {
  serverUrl: string;
  sessionId: string;
  /** Max events per HTTP request. Default: 50 */
  maxBatchSize: number;
  /** Interval between automatic flushes in ms. Default: 2000 */
  flushIntervalMs: number;
  /** Retries per batch on 5xx. Default: 3 */
  maxRetries: number;
  /** Base backoff between retries in ms. Default: 1000 */
  retryBackoffMs: number;
  /** Ring buffer capacity. Default: 10000 */
  maxQueueSize: number;
  /** Extra headers for every request */
  headers?: Record<string, string>;
}

export interface BatchSenderStats {
  queued: number;
  sent: number;
  dropped: number;
  errors: number;
}

const DEFAULT_CONFIG: Omit<BatchSenderConfig, 'serverUrl' | 'sessionId'> = {
  maxBatchSize: 50,
  flushIntervalMs: 2_000,
  maxRetries: 3,
  retryBackoffMs: 1_000,
  maxQueueSize: 10_000,
};

export class BatchSender {
  private readonly config: BatchSenderConfig;
  private readonly queue: RingBuffer<ProbeEvent>;
  private readonly circuitBreaker: CircuitBreaker;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing: boolean = false;
  private stats = { sent: 0, dropped: 0, errors: 0 };

  constructor(
    config: Partial<BatchSenderConfig> &
      Pick<BatchSenderConfig, 'serverUrl' | 'sessionId'>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config } as BatchSenderConfig;
    this.queue = new RingBuffer<ProbeEvent>(this.config.maxQueueSize);
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeoutMs: 30_000,
      halfOpenMaxAttempts: 1,
    });
  }

  /** Add an event to the ring buffer. Oldest events are evicted when full. */
  enqueue(event: ProbeEvent): void {
    const evicted = this.queue.push(event);
    if (evicted !== undefined) {
      this.stats.dropped++;
    }
  }

  /** Drain up to maxBatchSize events and POST them. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;

    try {
      while (!this.queue.isEmpty) {
        const batch = this.drainBatch();
        if (batch.length === 0) break;

        const ok = await this.sendBatchWithRetry(batch);
        if (!ok) {
          // All retries failed — events are dropped
          this.stats.dropped += batch.length;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Start the automatic flush timer. */
  start(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.config.flushIntervalMs);
  }

  /** Stop the timer and flush remaining events (best effort). */
  async stop(): Promise<void> {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Best-effort final flush
    await this.flush();
  }

  getStats(): BatchSenderStats {
    return {
      queued: this.queue.size,
      sent: this.stats.sent,
      dropped: this.stats.dropped,
      errors: this.stats.errors,
    };
  }

  // ---- Internals ----

  /** Drain up to maxBatchSize events from the ring buffer. */
  private drainBatch(): ProbeEvent[] {
    const batch: ProbeEvent[] = [];
    const count = Math.min(this.config.maxBatchSize, this.queue.size);
    for (let i = 0; i < count; i++) {
      const event = this.queue.shift();
      if (event !== undefined) batch.push(event);
    }
    return batch;
  }

  /** Attempt to send a batch, retrying on 5xx with exponential backoff. */
  private async sendBatchWithRetry(batch: ProbeEvent[]): Promise<boolean> {
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const success = await this.circuitBreaker.execute(() =>
          this.sendBatch(batch),
        );
        if (success) {
          this.stats.sent += batch.length;
          return true;
        }
        // Non-retryable failure (e.g. 4xx) — stop immediately
        return false;
      } catch (error) {
        this.stats.errors++;

        if (error instanceof CircuitOpenError) {
          // Don't retry when circuit is open — fail immediately
          return false;
        }

        if (attempt < this.config.maxRetries) {
          const delay = this.config.retryBackoffMs * 2 ** attempt;
          await this.sleep(delay);
        }
      }
    }
    return false;
  }

  /** POST a batch to the ingest endpoint. Returns true on 2xx. */
  private async sendBatch(batch: ProbeEvent[]): Promise<boolean> {
    const url = `${this.config.serverUrl}/api/sessions/${encodeURIComponent(this.config.sessionId)}/events`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.config.headers,
      },
      body: JSON.stringify({ events: batch }),
    });

    if (response.ok) return true;

    if (response.status >= 500) {
      throw new Error(`Server error: ${response.status}`);
    }

    // 4xx → don't retry, consider it a permanent failure
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
