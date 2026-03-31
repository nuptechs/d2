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
  private purgeTimer: ReturnType<typeof setInterval> | null = null;
  private readonly storage: StoragePort;

  constructor(storage: StoragePort) {
    this.storage = storage;
    this.purgeTimer = setInterval(() => this.purgeStale(), PURGE_INTERVAL_MS);
    if (this.purgeTimer.unref) this.purgeTimer.unref();
  }

  /** Remove sessions older than TTL that are completed or errored */
  private async purgeStale(): Promise<void> {
    const cutoff = nowMs() - SESSION_TTL_MS;
    const sessions = await this.storage.listSessions();
    for (const session of sessions) {
      const status = session.status;
      const lastActivity = session.endedAt ?? session.startedAt;
      if ((status === 'completed' || status === 'error') && lastActivity < cutoff) {
        await this.storage.deleteSession(session.id);
        this.correlators.delete(session.id);
      }
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
    return true;
  }

  async updateSessionStatus(id: string, status: SessionStatus): Promise<DebugSession | null> {
    const existing = await this.storage.loadSession(id);
    if (!existing) return null;

    const patch: Partial<DebugSession> = {};
    if (status === 'completed' || status === 'error') {
      patch.endedAt = nowMs();
    }

    await this.storage.updateSessionStatus(id, status, patch);
    return this.storage.loadSession(id);
  }

  async ingestEvents(sessionId: string, events: ProbeEvent[]): Promise<number> {
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

    // Notify listeners (WebSocket)
    for (const listener of this.ingestListeners) {
      listener(sessionId, events);
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
    const entry = this.correlators.get(sessionId);
    if (!entry) {
      // Rebuild correlator from stored events
      const session = await this.storage.loadSession(sessionId);
      if (!session) return undefined;

      const config: CorrelationConfig =
        (session.config as SessionConfig)?.correlation ?? DEFAULT_CORRELATION_CONFIG;
      const correlator = this.createCorrelatorSync(config);
      const events = await this.storage.getEvents(sessionId);
      for (const event of events) {
        correlator.ingest(event);
      }
      this.correlators.set(sessionId, { correlator, lastAccessed: Date.now() });
      this.evictStaleCorrelators();
      return correlator.buildTimeline();
    }
    entry.lastAccessed = Date.now();
    return entry.correlator.buildTimeline();
  }

  async getCorrelationGroups(sessionId: string): Promise<CorrelationGroup[] | undefined> {
    const entry = this.correlators.get(sessionId);
    if (!entry) {
      const session = await this.storage.loadSession(sessionId);
      if (!session) return undefined;

      const config: CorrelationConfig =
        (session.config as SessionConfig)?.correlation ?? DEFAULT_CORRELATION_CONFIG;
      const correlator = this.createCorrelatorSync(config);
      const events = await this.storage.getEvents(sessionId);
      for (const event of events) {
        correlator.ingest(event);
      }
      this.correlators.set(sessionId, { correlator, lastAccessed: Date.now() });
      this.evictStaleCorrelators();
      return correlator.getGroups();
    }
    entry.lastAccessed = Date.now();
    return entry.correlator.getGroups();
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
          if ((e as unknown as Record<string, unknown>)['type'] === 'error') errors++;
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
