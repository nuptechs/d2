// ============================================================
// SessionManager — In-memory session & event management
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

interface SessionEntry {
  session: DebugSession;
  events: ProbeEvent[];
  correlator: CorrelatorPort;
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

export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly ingestListeners: EventIngestListener[] = [];

  createSession(name: string, config: SessionConfig, tags?: string[]): DebugSession {
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

    // Lazy import to avoid circular issues — correlator created inline
    const correlationConfig: CorrelationConfig =
      config.correlation ?? DEFAULT_CORRELATION_CONFIG;

    // We'll use a lightweight wrapper since we import @probe/correlation-engine lazily
    const correlator = this.createCorrelatorSync(correlationConfig);

    this.sessions.set(id, { session, events: [], correlator });
    return session;
  }

  listSessions(): DebugSession[] {
    return Array.from(this.sessions.values()).map((e) => e.session);
  }

  getSession(id: string): DebugSession | undefined {
    return this.sessions.get(id)?.session;
  }

  deleteSession(id: string): boolean {
    return this.sessions.delete(id);
  }

  updateSessionStatus(id: string, status: SessionStatus): DebugSession | undefined {
    const entry = this.sessions.get(id);
    if (!entry) return undefined;

    entry.session = {
      ...entry.session,
      status,
      ...(status === 'completed' || status === 'error' ? { endedAt: nowMs() } : {}),
    };
    return entry.session;
  }

  ingestEvents(sessionId: string, events: ProbeEvent[]): number {
    const entry = this.sessions.get(sessionId);
    if (!entry) return 0;

    for (const event of events) {
      entry.events.push(event);
      entry.correlator.ingest(event);
    }

    entry.session = {
      ...entry.session,
      eventCount: entry.events.length,
    };

    // Notify listeners (WebSocket)
    for (const listener of this.ingestListeners) {
      listener(sessionId, events);
    }

    return events.length;
  }

  getEvents(sessionId: string, query: EventQuery): ProbeEvent[] {
    const entry = this.sessions.get(sessionId);
    if (!entry) return [];

    let filtered = entry.events;

    if (query.source) {
      filtered = filtered.filter((e) => e.source === query.source);
    }
    if (query.type) {
      filtered = filtered.filter((e) => (e as unknown as Record<string, unknown>)['type'] === query.type);
    }
    if (query.fromTime !== undefined) {
      filtered = filtered.filter((e) => e.timestamp >= query.fromTime!);
    }
    if (query.toTime !== undefined) {
      filtered = filtered.filter((e) => e.timestamp <= query.toTime!);
    }

    const offset = query.offset ?? 0;
    const limit = query.limit ?? 500;
    return filtered.slice(offset, offset + limit);
  }

  getTimeline(sessionId: string): Timeline | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    return entry.correlator.buildTimeline();
  }

  getCorrelationGroups(sessionId: string): CorrelationGroup[] | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    return entry.correlator.getGroups();
  }

  onEventsIngested(listener: EventIngestListener): () => void {
    this.ingestListeners.push(listener);
    return () => {
      const idx = this.ingestListeners.indexOf(listener);
      if (idx >= 0) this.ingestListeners.splice(idx, 1);
    };
  }

  /**
   * Create a minimal correlator that buffers events and delegates to
   * @probe/correlation-engine when the real module is available.
   * For MVP, we implement the port inline to avoid async init.
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
