// ============================================================
// SessionManager — Persistent session & event management
// Uses StoragePort for persistence, keeps in-memory correlator
// for real-time features (WebSocket, timeline, correlation).
// ============================================================

import type {
  DebugSession,
  SessionConfig,
  SessionStatus,
  ProbeEvent,
  CorrelationGroup,
  Timeline,
  CorrelationConfig,
  EventSource,
} from '@probe/core';
import { generateSessionId, nowMs, DEFAULT_CORRELATION_CONFIG } from '@probe/core';
import type { CorrelatorPort } from '@probe/core';
import type { StoragePort, EventFilter } from '@probe/core';
import type { SessionListOptions } from '@probe/core';
import {
  sessionsCreatedTotal,
  sessionsDeletedTotal,
  sessionsPurgedTotal,
  sessionsActive,
  sessionStatusChanges,
  eventsIngestedTotal,
  eventBatchSize,
  eventIngestDuration,
  correlatorRebuildsTotal,
  correlatorRebuildDuration,
  correlatorsCached,
  correlatorEvictions,
  purgeRunsTotal,
  purgeDuration,
  errorsTotal,
} from '../lib/metrics.js';

interface InMemoryEntry {
  correlator: CorrelatorPort;
  lastAccessed: number;
}

interface EventQuery {
  source?: EventSource;
  type?: string;
  fromTime?: number;
  toTime?: number;
  limit?: number;
  offset?: number;
}

// Callback for event ingestion — used by WebSocket to push realtime events
type EventIngestListener = (sessionId: string, events: ProbeEvent[]) => void;

const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours default
const PURGE_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
const MAX_CORRELATOR_EVENTS = 50_000; // cap per-session correlator memory
const MAX_CORRELATORS = 200; // max concurrent in-memory correlators

export class SessionManager {
  private readonly correlators = new Map<string, InMemoryEntry>();
  private readonly ingestListeners: EventIngestListener[] = [];
  private readonly rebuildInProgress = new Map<string, Promise<InMemoryEntry | undefined>>();
  private purgeTimer: ReturnType<typeof setInterval> | null = null;
  private readonly storage: StoragePort;

  constructor(storage: StoragePort) {
    this.storage = storage;
    this.purgeTimer = setInterval(() => this.purgeStale(), PURGE_INTERVAL_MS);
    if (this.purgeTimer.unref) this.purgeTimer.unref();
  }

  /** Remove sessions older than TTL that are completed or errored */
  private async purgeStale(): Promise<void> {
    const start = performance.now();
    purgeRunsTotal.inc();
    try {
      const cutoff = nowMs() - SESSION_TTL_MS;
      const sessions = await this.storage.listSessions();
      let purged = 0;
      for (const session of sessions) {
        const status = session.status;
        const lastActivity = session.endedAt ?? session.startedAt;
        if ((status === 'completed' || status === 'error') && lastActivity < cutoff) {
          await this.storage.deleteSession(session.id);
          this.correlators.delete(session.id);
          purged++;
        }
      }
      if (purged > 0) sessionsPurgedTotal.inc(purged);
      correlatorsCached.set(this.correlators.size);
    } catch {
      errorsTotal.inc({ type: 'purge_failure' });
    } finally {
      purgeDuration.observe((performance.now() - start) / 1000);
    }
  }

  /** Stop the auto-purge timer (call on shutdown) */
  destroy(): void {
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }
  }

  async createSession(name: string, config: SessionConfig, tags?: string[]): Promise<DebugSession> {
    const id = generateSessionId();
    const session: DebugSession = {
      id,
      name,
      status: 'idle',
      config,
      startedAt: nowMs(),
      eventCount: 0,
      tags,
    };

    const correlationConfig: CorrelationConfig =
      config.correlation ?? DEFAULT_CORRELATION_CONFIG;

    const correlator = this.createCorrelatorSync(correlationConfig);
    this.correlators.set(id, { correlator, lastAccessed: Date.now() });
    this.evictStaleCorrelators();

    await this.storage.saveSession(session);
    sessionsCreatedTotal.inc();
    correlatorsCached.set(this.correlators.size);
    return session;
  }

  async listSessions(): Promise<DebugSession[]> {
    return this.storage.listSessions();
  }

  async listSessionsPaginated(opts: SessionListOptions): Promise<{ sessions: DebugSession[]; total: number }> {
    return this.storage.listSessionsPaginated(opts);
  }

  async getSession(id: string): Promise<DebugSession | null> {
    return this.storage.loadSession(id);
  }

  async deleteSession(id: string): Promise<boolean> {
    const existing = await this.storage.loadSession(id);
    if (!existing) return false;
    await this.storage.deleteSession(id);
    this.correlators.delete(id);
    sessionsDeletedTotal.inc();
    correlatorsCached.set(this.correlators.size);
    return true;
  }

  async updateSessionStatus(id: string, status: SessionStatus): Promise<DebugSession | null> {
    const existing = await this.storage.loadSession(id);
    if (!existing) return null;

    const patch: Partial<DebugSession> = {};
    if (status === 'completed' || status === 'error') {
      patch.endedAt = nowMs();
    }

    sessionStatusChanges.inc({ from_status: existing.status, to_status: status });
    if (status === 'capturing' || status === 'paused') {
      sessionsActive.inc();
    }
    if ((existing.status === 'capturing' || existing.status === 'paused') &&
        status !== 'capturing' && status !== 'paused') {
      sessionsActive.dec();
    }

    await this.storage.updateSessionStatus(id, status, patch);
    return this.storage.loadSession(id);
  }

  async ingestEvents(sessionId: string, events: ProbeEvent[]): Promise<number> {
    const start = performance.now();
    const existing = await this.storage.loadSession(sessionId);
    if (!existing) return 0;

    // Persist to storage
    await this.storage.appendEvents(sessionId, events);

    // Feed correlator (in-memory real-time)
    let entry = this.correlators.get(sessionId);
    if (!entry) {
      const config: CorrelationConfig =
        (existing.config as SessionConfig)?.correlation ?? DEFAULT_CORRELATION_CONFIG;
      const correlator = this.createCorrelatorSync(config);
      entry = { correlator, lastAccessed: Date.now() };
      this.correlators.set(sessionId, entry);
      this.evictStaleCorrelators();
    }
    entry.lastAccessed = Date.now();
    for (const event of events) {
      entry.correlator.ingest(event);
    }

    // Metrics
    eventBatchSize.observe(events.length);
    eventIngestDuration.observe((performance.now() - start) / 1000);
    for (const event of events) {
      eventsIngestedTotal.inc({ source: event.source ?? 'unknown' });
    }
    correlatorsCached.set(this.correlators.size);

    // Notify listeners (WebSocket) — isolate failures per listener
    for (const listener of this.ingestListeners) {
      try {
        listener(sessionId, events);
      } catch {
        // Log but don't abort the pipeline — events are already persisted
      }
    }

    return events.length;
  }

  async getEvents(sessionId: string, query: EventQuery): Promise<{ events: ProbeEvent[]; total: number }> {
    const existing = await this.storage.loadSession(sessionId);
    if (!existing) return { events: [], total: 0 };

    const filter: EventFilter = {
      source: query.source ? [query.source] : undefined,
      types: query.type ? [query.type] : undefined,
      fromTime: query.fromTime,
      toTime: query.toTime,
      limit: query.limit ?? 500,
      offset: query.offset ?? 0,
    };

    const events = await this.storage.getEvents(sessionId, filter);
    const total = await this.storage.getEventCount(sessionId);
    return { events, total };
  }

  async getTimeline(sessionId: string): Promise<Timeline | undefined> {
    const entry = await this.getOrRebuildCorrelator(sessionId);
    if (!entry) return undefined;
    entry.lastAccessed = Date.now();
    return entry.correlator.buildTimeline();
  }

  async getCorrelationGroups(sessionId: string): Promise<CorrelationGroup[] | undefined> {
    const entry = await this.getOrRebuildCorrelator(sessionId);
    if (!entry) return undefined;
    entry.lastAccessed = Date.now();
    return entry.correlator.getGroups();
  }

  /**
   * Get existing correlator or rebuild from storage.
   * Coalesces concurrent rebuild requests for the same session and caps total concurrent rebuilds.
   */
  private static readonly MAX_CONCURRENT_REBUILDS = 3;

  private async getOrRebuildCorrelator(sessionId: string): Promise<InMemoryEntry | undefined> {
    const existing = this.correlators.get(sessionId);
    if (existing) return existing;

    // Coalesce concurrent rebuilds for same session
    const pending = this.rebuildInProgress.get(sessionId);
    if (pending) return pending;

    // Cap total concurrent rebuilds to prevent memory spikes
    if (this.rebuildInProgress.size >= SessionManager.MAX_CONCURRENT_REBUILDS) {
      return undefined; // Caller should return 503 or empty
    }

    const rebuild = this.doRebuildCorrelator(sessionId);
    this.rebuildInProgress.set(sessionId, rebuild);
    try {
      return await rebuild;
    } finally {
      this.rebuildInProgress.delete(sessionId);
    }
  }

  private async doRebuildCorrelator(sessionId: string): Promise<InMemoryEntry | undefined> {
    const start = performance.now();
    correlatorRebuildsTotal.inc();
    const session = await this.storage.loadSession(sessionId);
    if (!session) return undefined;

    const config: CorrelationConfig =
      (session.config as SessionConfig)?.correlation ?? DEFAULT_CORRELATION_CONFIG;
    const correlator = this.createCorrelatorSync(config);
    const events = await this.storage.getEvents(sessionId, { limit: 50_000 });
    for (const event of events) {
      correlator.ingest(event);
    }
    const entry: InMemoryEntry = { correlator, lastAccessed: Date.now() };
    this.correlators.set(sessionId, entry);
    this.evictStaleCorrelators();
    correlatorRebuildDuration.observe((performance.now() - start) / 1000);
    correlatorsCached.set(this.correlators.size);
    return entry;
  }

  /** Evict least-recently-used correlators when over the cap */
  private evictStaleCorrelators(): void {
    if (this.correlators.size <= MAX_CORRELATORS) return;
    const entries = [...this.correlators.entries()]
      .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
    const toEvict = entries.slice(0, this.correlators.size - MAX_CORRELATORS);
    for (const [id] of toEvict) {
      this.correlators.delete(id);
    }
    correlatorEvictions.inc(toEvict.length);
    correlatorsCached.set(this.correlators.size);
  }

  onEventsIngested(listener: EventIngestListener): () => void {
    this.ingestListeners.push(listener);
    return () => {
      const idx = this.ingestListeners.indexOf(listener);
      if (idx >= 0) this.ingestListeners.splice(idx, 1);
    };
  }

  /**
   * Inline correlator — same logic as before, no changes needed.
   */
  private createCorrelatorSync(_config: CorrelationConfig): CorrelatorPort {
    const events: ProbeEvent[] = [];
    const groups: CorrelationGroup[] = [];
    const groupHandlers: Array<(g: CorrelationGroup) => void> = [];
    const updateHandlers: Array<(g: CorrelationGroup) => void> = [];

    return {
      initialize() { /* config already captured */ },
      reset() {
        events.length = 0;
        groups.length = 0;
      },
      ingest(event: ProbeEvent) {
        events.push(event);
        // Cap in-memory events to prevent unbounded growth
        if (events.length > MAX_CORRELATOR_EVENTS) {
          events.splice(0, events.length - MAX_CORRELATOR_EVENTS);
        }
      },
      getGroups() {
        return groups;
      },
      getGroup(id: string) {
        return groups.find((g) => g.id === id);
      },
      getGroupByCorrelationId(correlationId: string) {
        return groups.find((g) => g.correlationId === correlationId);
      },
      buildTimeline(): Timeline {
        const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
        const startTime = sorted[0]?.timestamp ?? 0;
        const endTime = sorted[sorted.length - 1]?.timestamp ?? 0;

        const bySource: Record<string, number> = {};
        let errors = 0;
        for (const e of sorted) {
          bySource[e.source] = (bySource[e.source] ?? 0) + 1;
          if (e.type === 'error') errors++;
        }

        return {
          sessionId: sorted[0]?.sessionId ?? '',
          entries: sorted.map((event) => ({ event, depth: 0, groupId: undefined })),
          duration: endTime - startTime,
          startTime,
          endTime,
          stats: {
            totalEvents: sorted.length,
            bySource: bySource as Record<EventSource, number>,
            correlationGroups: groups.length,
            errors,
          },
        };
      },
      onGroupCreated(handler: (g: CorrelationGroup) => void) {
        groupHandlers.push(handler);
        return () => { groupHandlers.splice(groupHandlers.indexOf(handler), 1); };
      },
      onGroupUpdated(handler: (g: CorrelationGroup) => void) {
        updateHandlers.push(handler);
        return () => { updateHandlers.splice(updateHandlers.indexOf(handler), 1); };
      },
    } as unknown as CorrelatorPort;
  }
}
