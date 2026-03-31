// ============================================================
// MemoryStorageAdapter — In-memory persistence for StoragePort
// Intended for testing and short-lived sessions
// ============================================================

import { StoragePort, type EventFilter } from '../ports/storage.port.js';
import type { DebugSession, ProbeEvent } from '../types/index.js';

interface SessionEntry {
  session: DebugSession;
  events: ProbeEvent[];
}

export class MemoryStorageAdapter extends StoragePort {
  private static readonly MAX_EVENTS_PER_SESSION = 100_000;
  private static readonly MAX_SESSIONS = 10_000;
  private store = new Map<string, SessionEntry>();

  // ---- Session CRUD ----

  async saveSession(session: DebugSession): Promise<void> {
    const existing = this.store.get(session.id);
    // Enforce session cap — evict oldest if at limit
    if (!existing && this.store.size >= MemoryStorageAdapter.MAX_SESSIONS) {
      const oldest = this.store.keys().next().value;
      if (oldest) this.store.delete(oldest);
    }
    this.store.set(session.id, {
      session: structuredClone(session),
      events: existing?.events ?? [],
    });
  }

  async loadSession(id: string): Promise<DebugSession | null> {
    const entry = this.store.get(id);
    return entry ? structuredClone(entry.session) : null;
  }

  async listSessions(): Promise<DebugSession[]> {
    return [...this.store.values()].map((e) => structuredClone(e.session));
  }

  async deleteSession(id: string): Promise<void> {
    this.store.delete(id);
  }

  async updateSessionStatus(
    id: string,
    status: DebugSession['status'],
    patch?: Partial<DebugSession>,
  ): Promise<void> {
    const entry = this.store.get(id);
    if (!entry) throw new Error(`Session not found: ${id}`);
    entry.session = { ...entry.session, ...patch, status, id };
  }

  // ---- Event storage ----

  async appendEvent(sessionId: string, event: ProbeEvent): Promise<void> {
    const entry = this.store.get(sessionId);
    if (!entry) throw new Error(`Session not found: ${sessionId}`);
    if (entry.events.length >= MemoryStorageAdapter.MAX_EVENTS_PER_SESSION) {
      entry.events.splice(0, 1); // drop oldest
    }
    entry.events.push(structuredClone(event));
  }

  async appendEvents(sessionId: string, events: ProbeEvent[]): Promise<void> {
    const entry = this.store.get(sessionId);
    if (!entry) throw new Error(`Session not found: ${sessionId}`);
    for (const event of events) {
      if (entry.events.length >= MemoryStorageAdapter.MAX_EVENTS_PER_SESSION) {
        entry.events.splice(0, 1); // drop oldest
      }
      entry.events.push(structuredClone(event));
    }
  }

  async getEvents(sessionId: string, filter?: EventFilter): Promise<ProbeEvent[]> {
    const entry = this.store.get(sessionId);
    if (!entry) return [];

    let results = entry.events.filter((e) => this.matchesFilter(e, filter));

    if (filter?.offset) {
      results = results.slice(filter.offset);
    }
    if (filter?.limit) {
      results = results.slice(0, filter.limit);
    }

    return results.map((e) => structuredClone(e));
  }

  async getEventCount(sessionId: string): Promise<number> {
    return this.store.get(sessionId)?.events.length ?? 0;
  }

  // ---- Lifecycle ----

  async initialize(): Promise<void> {
    // No-op
  }

  async close(): Promise<void> {
    this.store.clear();
  }

  // ---- Filter matching ----

  private matchesFilter(event: ProbeEvent, filter?: EventFilter): boolean {
    if (!filter) return true;

    if (filter.source && !filter.source.includes(event.source)) return false;

    if (filter.types) {
      if (!event.type || !filter.types.includes(event.type)) return false;
    }

    if (filter.fromTime != null && event.timestamp < filter.fromTime) return false;
    if (filter.toTime != null && event.timestamp > filter.toTime) return false;

    if (filter.correlationId && event.correlationId !== filter.correlationId) return false;

    return true;
  }
}
