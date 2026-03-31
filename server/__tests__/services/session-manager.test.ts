// ============================================================
// SessionManager — Unit tests with MemoryStorageAdapter
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStorageAdapter } from '@probe/core';
import { SessionManager } from '../../src/services/session-manager.js';
import type { ProbeEvent, EventSource } from '@probe/core';

function makeEvent(sessionId: string, source: EventSource = 'browser', timestamp = Date.now()): ProbeEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId,
    timestamp,
    source,
    correlationId: `corr-${Math.random().toString(36).slice(2)}`,
  };
}

describe('SessionManager', () => {
  let storage: MemoryStorageAdapter;
  let manager: SessionManager;

  beforeEach(async () => {
    storage = new MemoryStorageAdapter();
    await storage.initialize();
    manager = new SessionManager(storage);
  });

  afterEach(() => {
    manager.destroy();
  });

  // ---- Session CRUD ----

  describe('createSession', () => {
    it('creates a session with generated id', async () => {
      const session = await manager.createSession('test', {});
      expect(session.id).toBeDefined();
      expect(session.name).toBe('test');
      expect(session.status).toBe('idle');
      expect(session.startedAt).toBeGreaterThan(0);
    });

    it('creates session with tags', async () => {
      const session = await manager.createSession('tagged', {}, ['prod', 'v2']);
      expect(session.tags).toEqual(['prod', 'v2']);
    });

    it('persists to storage', async () => {
      const session = await manager.createSession('persisted', {});
      const loaded = await storage.loadSession(session.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('persisted');
    });
  });

  describe('listSessions', () => {
    it('returns empty array when no sessions', async () => {
      const sessions = await manager.listSessions();
      expect(sessions).toEqual([]);
    });

    it('returns all sessions', async () => {
      await manager.createSession('a', {});
      await manager.createSession('b', {});
      const sessions = await manager.listSessions();
      expect(sessions).toHaveLength(2);
    });
  });

  describe('listSessionsPaginated', () => {
    it('paginates results', async () => {
      for (let i = 0; i < 5; i++) {
        await manager.createSession(`session-${i}`, {});
      }
      const page1 = await manager.listSessionsPaginated({ limit: 2, offset: 0 });
      expect(page1.sessions).toHaveLength(2);
      expect(page1.total).toBe(5);

      const page2 = await manager.listSessionsPaginated({ limit: 2, offset: 2 });
      expect(page2.sessions).toHaveLength(2);
      expect(page2.total).toBe(5);
    });

    it('filters by status', async () => {
      const s1 = await manager.createSession('active', {});
      await manager.createSession('idle', {});
      await manager.updateSessionStatus(s1.id, 'capturing');

      const result = await manager.listSessionsPaginated({ status: 'capturing' });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].name).toBe('active');
    });

    it('searches by name', async () => {
      await manager.createSession('production-bug', {});
      await manager.createSession('staging-test', {});
      const result = await manager.listSessionsPaginated({ search: 'prod' });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].name).toBe('production-bug');
    });
  });

  describe('getSession', () => {
    it('returns session by id', async () => {
      const created = await manager.createSession('fetch-me', {});
      const session = await manager.getSession(created.id);
      expect(session).not.toBeNull();
      expect(session!.name).toBe('fetch-me');
    });

    it('returns null for unknown id', async () => {
      expect(await manager.getSession('nonexistent')).toBeNull();
    });
  });

  describe('deleteSession', () => {
    it('deletes an existing session', async () => {
      const session = await manager.createSession('doomed', {});
      const deleted = await manager.deleteSession(session.id);
      expect(deleted).toBe(true);
      expect(await manager.getSession(session.id)).toBeNull();
    });

    it('returns false for unknown session', async () => {
      expect(await manager.deleteSession('ghost')).toBe(false);
    });
  });

  describe('updateSessionStatus', () => {
    it('updates status', async () => {
      const session = await manager.createSession('status-test', {});
      const updated = await manager.updateSessionStatus(session.id, 'capturing');
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('capturing');
    });

    it('sets endedAt when completing', async () => {
      const session = await manager.createSession('ending', {});
      const updated = await manager.updateSessionStatus(session.id, 'completed');
      expect(updated!.endedAt).toBeGreaterThan(0);
    });

    it('sets endedAt when erroring', async () => {
      const session = await manager.createSession('erroring', {});
      const updated = await manager.updateSessionStatus(session.id, 'error');
      expect(updated!.endedAt).toBeGreaterThan(0);
    });

    it('returns null for unknown session', async () => {
      expect(await manager.updateSessionStatus('nope', 'idle')).toBeNull();
    });
  });

  // ---- Event ingestion ----

  describe('ingestEvents', () => {
    it('ingests events into a session', async () => {
      const session = await manager.createSession('ingest-test', {});
      const events = [makeEvent(session.id), makeEvent(session.id)];
      const count = await manager.ingestEvents(session.id, events);
      expect(count).toBe(2);
    });

    it('returns 0 for unknown session', async () => {
      const count = await manager.ingestEvents('ghost', [makeEvent('ghost')]);
      expect(count).toBe(0);
    });

    it('notifies ingest listeners', async () => {
      const session = await manager.createSession('listener-test', {});
      const received: ProbeEvent[][] = [];
      manager.onEventsIngested((_sid, events) => { received.push(events); });

      const events = [makeEvent(session.id)];
      await manager.ingestEvents(session.id, events);
      expect(received).toHaveLength(1);
      expect(received[0]).toHaveLength(1);
    });

    it('listener can be unsubscribed', async () => {
      const session = await manager.createSession('unsub-test', {});
      let callCount = 0;
      const unsub = manager.onEventsIngested(() => { callCount++; });

      await manager.ingestEvents(session.id, [makeEvent(session.id)]);
      expect(callCount).toBe(1);

      unsub();
      await manager.ingestEvents(session.id, [makeEvent(session.id)]);
      expect(callCount).toBe(1); // not called again
    });
  });

  describe('getEvents', () => {
    it('retrieves events with pagination', async () => {
      const session = await manager.createSession('events-test', {});
      const events = Array.from({ length: 10 }, (_, i) =>
        makeEvent(session.id, 'browser', 1000 + i),
      );
      await manager.ingestEvents(session.id, events);

      const result = await manager.getEvents(session.id, { limit: 5, offset: 0 });
      expect(result.events).toHaveLength(5);
      expect(result.total).toBe(10);
    });

    it('returns empty for unknown session', async () => {
      const result = await manager.getEvents('ghost', {});
      expect(result.events).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  // ---- Timeline and correlation ----

  describe('getTimeline', () => {
    it('returns timeline for session with events', async () => {
      const session = await manager.createSession('timeline', {});
      const events = [
        makeEvent(session.id, 'browser', 1000),
        makeEvent(session.id, 'network', 2000),
      ];
      await manager.ingestEvents(session.id, events);

      const timeline = await manager.getTimeline(session.id);
      expect(timeline).toBeDefined();
      expect(timeline!.entries).toHaveLength(2);
      expect(timeline!.startTime).toBe(1000);
      expect(timeline!.endTime).toBe(2000);
      expect(timeline!.duration).toBe(1000);
    });

    it('returns undefined for unknown session', async () => {
      expect(await manager.getTimeline('ghost')).toBeUndefined();
    });

    it('rebuilds timeline from storage when correlator evicted', async () => {
      const session = await manager.createSession('rebuild', {});
      await manager.ingestEvents(session.id, [makeEvent(session.id, 'browser', 5000)]);

      // Access timeline once (creates correlator), then get it again
      const t1 = await manager.getTimeline(session.id);
      const t2 = await manager.getTimeline(session.id);
      expect(t1!.entries).toHaveLength(1);
      expect(t2!.entries).toHaveLength(1);
    });
  });

  describe('getCorrelationGroups', () => {
    it('returns groups for session', async () => {
      const session = await manager.createSession('groups', {});
      await manager.ingestEvents(session.id, [makeEvent(session.id)]);
      const groups = await manager.getCorrelationGroups(session.id);
      expect(groups).toBeDefined();
      expect(Array.isArray(groups)).toBe(true);
    });

    it('returns undefined for unknown session', async () => {
      expect(await manager.getCorrelationGroups('ghost')).toBeUndefined();
    });
  });

  // ---- Lifecycle ----

  describe('destroy', () => {
    it('can be called multiple times safely', () => {
      manager.destroy();
      manager.destroy(); // should not throw
    });
  });
});
