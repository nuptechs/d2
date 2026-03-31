// ============================================================
// StoragePort — Abstraction for session & event persistence
// Adapters: File system, In-memory
// ============================================================

import type { DebugSession, ProbeEvent, EventSource } from '../types/index.js';

export interface EventFilter {
  source?: EventSource[];
  types?: string[];
  fromTime?: number;
  toTime?: number;
  correlationId?: string;
  limit?: number;
  offset?: number;
}

export interface SessionListOptions {
  limit?: number;
  offset?: number;
  status?: string;
  search?: string;
  orderBy?: string;
  order?: 'asc' | 'desc';
}

export abstract class StoragePort {
  // ---- Session CRUD ----
  abstract saveSession(session: DebugSession): Promise<void>;
  abstract loadSession(id: string): Promise<DebugSession | null>;
  abstract listSessions(): Promise<DebugSession[]>;
  abstract deleteSession(id: string): Promise<void>;
  abstract updateSessionStatus(
    id: string,
    status: DebugSession['status'],
    patch?: Partial<DebugSession>,
  ): Promise<void>;

  /**
   * Paginated session listing with server-side filtering.
   * Default implementation falls back to listSessions() + in-memory filtering.
   * PostgresStorageAdapter overrides with SQL-level pagination.
   */
  async listSessionsPaginated(opts: SessionListOptions): Promise<{ sessions: DebugSession[]; total: number }> {
    let sessions = await this.listSessions();

    if (opts.status) {
      sessions = sessions.filter((s) => s.status === opts.status);
    }
    if (opts.search?.trim()) {
      const q = opts.search.trim().toLowerCase();
      sessions = sessions.filter(
        (s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q),
      );
    }

    // Sort
    const order = opts.order === 'asc' ? 1 : -1;
    sessions.sort((a, b) => order * ((b.startedAt ?? 0) - (a.startedAt ?? 0)));

    const total = sessions.length;
    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = opts.offset ?? 0;

    return { sessions: sessions.slice(offset, offset + limit), total };
  }

  // ---- Event storage ----
  abstract appendEvent(sessionId: string, event: ProbeEvent): Promise<void>;
  abstract appendEvents(sessionId: string, events: ProbeEvent[]): Promise<void>;
  abstract getEvents(sessionId: string, filter?: EventFilter): Promise<ProbeEvent[]>;
  abstract getEventCount(sessionId: string): Promise<number>;

  // ---- Lifecycle ----
  abstract initialize(): Promise<void>;
  abstract close(): Promise<void>;
}
