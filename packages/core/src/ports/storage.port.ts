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

  // ---- Event storage ----
  abstract appendEvent(sessionId: string, event: ProbeEvent): Promise<void>;
  abstract appendEvents(sessionId: string, events: ProbeEvent[]): Promise<void>;
  abstract getEvents(sessionId: string, filter?: EventFilter): Promise<ProbeEvent[]>;
  abstract getEventCount(sessionId: string): Promise<number>;

  // ---- Lifecycle ----
  abstract initialize(): Promise<void>;
  abstract close(): Promise<void>;
}
