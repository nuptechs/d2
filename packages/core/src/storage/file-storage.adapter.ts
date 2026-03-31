// ============================================================
// FileStorageAdapter — Disk-based persistence for StoragePort
// Sessions: {basePath}/sessions/{id}/session.json
// Events:   {basePath}/sessions/{id}/events.jsonl (append-only)
// ============================================================

import { readFile, writeFile, rename, mkdir, readdir, rm, appendFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { StoragePort, type EventFilter } from '../ports/storage.port.js';
import type { DebugSession, ProbeEvent } from '../types/index.js';

export class FileStorageAdapter extends StoragePort {
  private readonly basePath: string;
  private readonly writeLocks = new Map<string, Promise<void>>();

  constructor(basePath: string = '.probe-data') {
    super();
    this.basePath = basePath;
  }

  /** Serialize writes per session to prevent interleaved appends */
  private async withWriteLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.writeLocks.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn); // Always chain even if previous failed
    this.writeLocks.set(sessionId, next);
    await next;
  }

  // ---- Helpers ----

  private sessionDir(id: string): string {
    // Defense-in-depth: reject session IDs with path separators or traversal
    if (!id || /[/\\]/.test(id) || id.includes('..')) {
      throw new Error(`Invalid session ID: ${id}`);
    }
    return join(this.basePath, 'sessions', id);
  }

  private sessionFile(id: string): string {
    return join(this.sessionDir(id), 'session.json');
  }

  private eventsFile(id: string): string {
    return join(this.sessionDir(id), 'events.jsonl');
  }

  /** Atomic write: write to .tmp then rename */
  private async atomicWrite(filePath: string, data: string): Promise<void> {
    const tmp = filePath + '.tmp';
    await writeFile(tmp, data, 'utf-8');
    await rename(tmp, filePath);
  }

  // ---- Session CRUD ----

  async saveSession(session: DebugSession): Promise<void> {
    const dir = this.sessionDir(session.id);
    await mkdir(dir, { recursive: true });
    await this.atomicWrite(this.sessionFile(session.id), JSON.stringify(session, null, 2));
  }

  async loadSession(id: string): Promise<DebugSession | null> {
    try {
      const raw = await readFile(this.sessionFile(id), 'utf-8');
      return JSON.parse(raw) as DebugSession;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async listSessions(): Promise<DebugSession[]> {
    const sessionsDir = join(this.basePath, 'sessions');
    let entries: string[];
    try {
      entries = await readdir(sessionsDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const sessions: DebugSession[] = [];
    for (const entry of entries) {
      const session = await this.loadSession(entry);
      if (session) sessions.push(session);
    }
    return sessions;
  }

  async deleteSession(id: string): Promise<void> {
    const dir = this.sessionDir(id);
    await rm(dir, { recursive: true, force: true });
    this.writeLocks.delete(id);
  }

  async updateSessionStatus(
    id: string,
    status: DebugSession['status'],
    patch?: Partial<DebugSession>,
  ): Promise<void> {
    const session = await this.loadSession(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    const updated: DebugSession = { ...session, ...patch, status, id };
    await this.atomicWrite(this.sessionFile(id), JSON.stringify(updated, null, 2));
  }

  // ---- Event storage ----

  async appendEvent(sessionId: string, event: ProbeEvent): Promise<void> {
    await this.withWriteLock(sessionId, async () => {
      const file = this.eventsFile(sessionId);
      await appendFile(file, JSON.stringify(event) + '\n', 'utf-8');
    });
  }

  async appendEvents(sessionId: string, events: ProbeEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.withWriteLock(sessionId, async () => {
      const file = this.eventsFile(sessionId);
      const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
      await appendFile(file, lines, 'utf-8');
    });
  }

  async getEvents(sessionId: string, filter?: EventFilter): Promise<ProbeEvent[]> {
    const file = this.eventsFile(sessionId);
    let stream: ReturnType<typeof createReadStream>;
    try {
      stream = createReadStream(file, { encoding: 'utf-8' });
    } catch {
      return [];
    }

    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const results: ProbeEvent[] = [];
    let skipped = 0;

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as ProbeEvent;
        if (!this.matchesFilter(event, filter)) continue;

        if (filter?.offset && skipped < filter.offset) {
          skipped++;
          continue;
        }

        results.push(event);
        if (filter?.limit && results.length >= filter.limit) break;
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    return results;
  }

  async getEventCount(sessionId: string): Promise<number> {
    const file = this.eventsFile(sessionId);
    let stream: ReturnType<typeof createReadStream>;
    try {
      stream = createReadStream(file, { encoding: 'utf-8' });
    } catch {
      return 0;
    }

    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let count = 0;

    try {
      for await (const line of rl) {
        if (line.trim()) count++;
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }

    return count;
  }

  // ---- Lifecycle ----

  async initialize(): Promise<void> {
    await mkdir(join(this.basePath, 'sessions'), { recursive: true });
  }

  async close(): Promise<void> {
    this.writeLocks.clear();
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
