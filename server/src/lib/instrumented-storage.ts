// ============================================================
// InstrumentedStorage — Wraps any StoragePort with Prometheus metrics
// ============================================================

import { StoragePort } from '@probe/core';
import type { EventFilter, SessionListOptions } from '@probe/core';
import type { DebugSession, ProbeEvent } from '@probe/core';
import {
  storageOperationDuration,
  storageOperationsTotal,
  storageErrors,
  pgPoolTotalConnections,
  pgPoolIdleConnections,
  pgPoolWaitingClients,
  pgPoolMaxConnections,
  pgCircuitBreakerState,
} from '../lib/metrics.js';

const CB_STATE_MAP: Record<string, number> = { closed: 0, 'half-open': 1, open: 2 };

/**
 * Decorator that wraps a StoragePort to record operation latency, counts, and errors.
 * The underlying adapter is fully delegated to — this is a transparent wrapper.
 */
export class InstrumentedStorage extends StoragePort {
  private readonly inner: StoragePort;
  private readonly storageType: string;
  private poolStatsInterval: ReturnType<typeof setInterval> | null = null;

  constructor(inner: StoragePort, storageType: string) {
    super();
    this.inner = inner;
    this.storageType = storageType;
  }

  /** Start periodic pool stats collection (every 10s). Call after initialize(). */
  startPoolStatsCollection(): void {
    if (this.poolStatsInterval) return;
    this.collectPoolStats(); // immediate first sample
    this.poolStatsInterval = setInterval(() => this.collectPoolStats(), 10_000);
    this.poolStatsInterval.unref(); // Don't prevent shutdown
  }

  /** Stop periodic pool stats collection. */
  stopPoolStatsCollection(): void {
    if (this.poolStatsInterval) {
      clearInterval(this.poolStatsInterval);
      this.poolStatsInterval = null;
    }
  }

  private collectPoolStats(): void {
    const stats = this.inner.getPoolStats();
    if (!stats) return;
    pgPoolTotalConnections.set(stats.totalCount);
    pgPoolIdleConnections.set(stats.idleCount);
    pgPoolWaitingClients.set(stats.waitingCount);
    pgPoolMaxConnections.set(stats.maxConnections);
    pgCircuitBreakerState.set(CB_STATE_MAP[stats.circuitBreakerState] ?? -1);
  }

  override getPoolStats() {
    return this.inner.getPoolStats();
  }

  private async track<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      const result = await fn();
      storageOperationsTotal.inc({ operation, storage_type: this.storageType, result: 'success' });
      return result;
    } catch (err) {
      storageOperationsTotal.inc({ operation, storage_type: this.storageType, result: 'error' });
      storageErrors.inc({ operation, storage_type: this.storageType });
      throw err;
    } finally {
      storageOperationDuration.observe(
        { operation, storage_type: this.storageType },
        (performance.now() - start) / 1000,
      );
    }
  }

  async saveSession(session: DebugSession): Promise<void> {
    return this.track('saveSession', () => this.inner.saveSession(session));
  }

  async loadSession(id: string): Promise<DebugSession | null> {
    return this.track('loadSession', () => this.inner.loadSession(id));
  }

  async listSessions(): Promise<DebugSession[]> {
    return this.track('listSessions', () => this.inner.listSessions());
  }

  async listSessionsPaginated(opts: SessionListOptions): Promise<{ sessions: DebugSession[]; total: number }> {
    return this.track('listSessionsPaginated', () => this.inner.listSessionsPaginated(opts));
  }

  async deleteSession(id: string): Promise<void> {
    return this.track('deleteSession', () => this.inner.deleteSession(id));
  }

  async updateSessionStatus(
    id: string,
    status: DebugSession['status'],
    patch?: Partial<DebugSession>,
  ): Promise<void> {
    return this.track('updateSessionStatus', () => this.inner.updateSessionStatus(id, status, patch));
  }

  async appendEvent(sessionId: string, event: ProbeEvent): Promise<void> {
    return this.track('appendEvent', () => this.inner.appendEvent(sessionId, event));
  }

  async appendEvents(sessionId: string, events: ProbeEvent[]): Promise<void> {
    return this.track('appendEvents', () => this.inner.appendEvents(sessionId, events));
  }

  async getEvents(sessionId: string, filter?: EventFilter): Promise<ProbeEvent[]> {
    return this.track('getEvents', () => this.inner.getEvents(sessionId, filter));
  }

  async getEventCount(sessionId: string): Promise<number> {
    return this.track('getEventCount', () => this.inner.getEventCount(sessionId));
  }

  async initialize(): Promise<void> {
    return this.track('initialize', () => this.inner.initialize());
  }

  async close(): Promise<void> {
    this.stopPoolStatsCollection();
    return this.track('close', () => this.inner.close());
  }
}

/** Wrap a StoragePort with metric instrumentation */
export function instrumentStorage(storage: StoragePort, storageType: string): InstrumentedStorage {
  return new InstrumentedStorage(storage, storageType);
}
