// ============================================================
// FileStorageAdapter — Comprehensive tests
// Path traversal defense, atomic writes, JSONL parsing, locks
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStorageAdapter } from '../../src/storage/file-storage.adapter.js';
import type { DebugSession, ProbeEvent } from '../../src/types/index.js';

// ── Helpers ───────────────────────────────────────────────────

function makeSession(id: string, overrides?: Partial<DebugSession>): DebugSession {
  return {
    id,
    name: `test-${id}`,
    status: 'idle',
    config: {},
    startedAt: Date.now(),
    eventCount: 0,
    ...overrides,
  };
}

function makeEvent(id: string, overrides?: Partial<ProbeEvent>): ProbeEvent {
  return {
    id,
    sessionId: 'sess-1',
    timestamp: Date.now(),
    source: 'sdk',
    type: 'request-start',
    ...overrides,
  } as ProbeEvent;
}

// ── Tests ─────────────────────────────────────────────────────

describe('FileStorageAdapter', () => {
  let basePath: string;
  let storage: FileStorageAdapter;

  beforeEach(async () => {
    basePath = await mkdtemp(join(tmpdir(), 'probe-test-'));
    storage = new FileStorageAdapter(basePath);
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    await rm(basePath, { recursive: true, force: true });
  });

  // ── Path traversal defense (R7-11) ──

  describe('path traversal defense', () => {
    it('rejects session ID with ..', async () => {
      await expect(storage.saveSession(makeSession('../escape'))).rejects.toThrow('Invalid session ID');
    });

    it('rejects session ID with forward slash', async () => {
      await expect(storage.saveSession(makeSession('foo/bar'))).rejects.toThrow('Invalid session ID');
    });

    it('rejects session ID with backslash', async () => {
      await expect(storage.saveSession(makeSession('foo\\bar'))).rejects.toThrow('Invalid session ID');
    });

    it('rejects empty session ID', async () => {
      await expect(storage.saveSession(makeSession(''))).rejects.toThrow('Invalid session ID');
    });

    it('rejects loadSession with traversal attempt', async () => {
      await expect(storage.loadSession('../../etc/passwd')).rejects.toThrow('Invalid session ID');
    });

    it('rejects deleteSession with traversal attempt', async () => {
      await expect(storage.deleteSession('../escape')).rejects.toThrow('Invalid session ID');
    });

    it('rejects appendEvent with traversal in sessionId', async () => {
      await expect(storage.appendEvent('../x', makeEvent('e1'))).rejects.toThrow('Invalid session ID');
    });

    it('accepts valid session ID with dashes and underscores', async () => {
      const session = makeSession('sess-abc_123');
      await storage.saveSession(session);
      const loaded = await storage.loadSession('sess-abc_123');
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('test-sess-abc_123');
    });
  });

  // ── Session CRUD ──

  describe('session CRUD', () => {
    it('saves and loads a session', async () => {
      const session = makeSession('s1', { name: 'My Session', status: 'capturing' });
      await storage.saveSession(session);
      const loaded = await storage.loadSession('s1');
      expect(loaded).toEqual(session);
    });

    it('returns null for non-existent session', async () => {
      const loaded = await storage.loadSession('nonexistent');
      expect(loaded).toBeNull();
    });

    it('lists all sessions', async () => {
      await storage.saveSession(makeSession('a'));
      await storage.saveSession(makeSession('b'));
      await storage.saveSession(makeSession('c'));
      const sessions = await storage.listSessions();
      expect(sessions).toHaveLength(3);
      const ids = sessions.map((s) => s.id).sort();
      expect(ids).toEqual(['a', 'b', 'c']);
    });

    it('returns empty array when no sessions exist', async () => {
      const sessions = await storage.listSessions();
      expect(sessions).toEqual([]);
    });

    it('deletes a session and its events', async () => {
      await storage.saveSession(makeSession('del'));
      await storage.appendEvent('del', makeEvent('e1', { sessionId: 'del' }));
      await storage.deleteSession('del');
      const loaded = await storage.loadSession('del');
      expect(loaded).toBeNull();
    });

    it('updates session status', async () => {
      await storage.saveSession(makeSession('upd'));
      await storage.updateSessionStatus('upd', 'completed', { endedAt: Date.now() });
      const loaded = await storage.loadSession('upd');
      expect(loaded!.status).toBe('completed');
      expect(loaded!.endedAt).toBeDefined();
    });

    it('throws when updating non-existent session', async () => {
      await expect(storage.updateSessionStatus('nope', 'completed')).rejects.toThrow('Session not found');
    });

    it('updateSessionStatus preserves session ID (no ID overwrite)', async () => {
      await storage.saveSession(makeSession('keep-id'));
      await storage.updateSessionStatus('keep-id', 'error', { id: 'evil-id' } as any);
      const loaded = await storage.loadSession('keep-id');
      expect(loaded!.id).toBe('keep-id');
    });
  });

  // ── Atomic writes ──

  describe('atomic writes', () => {
    it('does not leave .tmp files after successful write', async () => {
      await storage.saveSession(makeSession('atomic'));
      const { readdir } = await import('node:fs/promises');
      const dir = join(basePath, 'sessions', 'atomic');
      const files = await readdir(dir);
      expect(files.every((f) => !f.endsWith('.tmp'))).toBe(true);
    });

    it('overwrites existing session data', async () => {
      await storage.saveSession(makeSession('ow', { name: 'first', status: 'idle' }));
      await storage.saveSession(makeSession('ow', { name: 'second', status: 'capturing' }));
      const loaded = await storage.loadSession('ow');
      expect(loaded!.name).toBe('second');
      expect(loaded!.status).toBe('capturing');
    });
  });

  // ── JSONL event storage ──

  describe('event storage (JSONL)', () => {
    it('appends single event and reads it back', async () => {
      await storage.saveSession(makeSession('ev'));
      const event = makeEvent('e1', { sessionId: 'ev' });
      await storage.appendEvent('ev', event);
      const events = await storage.getEvents('ev');
      expect(events).toHaveLength(1);
      expect(events[0]!.id).toBe('e1');
    });

    it('appends batch of events', async () => {
      await storage.saveSession(makeSession('batch'));
      const events = Array.from({ length: 5 }, (_, i) => makeEvent(`e${i}`, { sessionId: 'batch' }));
      await storage.appendEvents('batch', events);
      const result = await storage.getEvents('batch');
      expect(result).toHaveLength(5);
    });

    it('returns empty array for session with no events', async () => {
      await storage.saveSession(makeSession('empty'));
      const events = await storage.getEvents('empty');
      expect(events).toEqual([]);
    });

    it('appendEvents with empty array is no-op', async () => {
      await storage.saveSession(makeSession('noop'));
      await storage.appendEvents('noop', []);
      const count = await storage.getEventCount('noop');
      expect(count).toBe(0);
    });

    it('getEventCount returns correct count', async () => {
      await storage.saveSession(makeSession('cnt'));
      await storage.appendEvents('cnt', [
        makeEvent('e1', { sessionId: 'cnt' }),
        makeEvent('e2', { sessionId: 'cnt' }),
        makeEvent('e3', { sessionId: 'cnt' }),
      ]);
      const count = await storage.getEventCount('cnt');
      expect(count).toBe(3);
    });

    it('handles blank lines in JSONL file gracefully', async () => {
      await storage.saveSession(makeSession('blank'));
      // Write JSONL manually with blank lines
      const dir = join(basePath, 'sessions', 'blank');
      const file = join(dir, 'events.jsonl');
      const content = [
        JSON.stringify(makeEvent('e1', { sessionId: 'blank' })),
        '',
        '  ',
        JSON.stringify(makeEvent('e2', { sessionId: 'blank' })),
        '',
      ].join('\n');
      await writeFile(file, content, 'utf-8');

      const events = await storage.getEvents('blank');
      expect(events).toHaveLength(2);
    });
  });

  // ── Filtering ──

  describe('event filtering', () => {
    beforeEach(async () => {
      await storage.saveSession(makeSession('flt'));
      await storage.appendEvents('flt', [
        makeEvent('e1', { sessionId: 'flt', source: 'browser', timestamp: 1000 } as any),
        makeEvent('e2', { sessionId: 'flt', source: 'network', timestamp: 2000 } as any),
        makeEvent('e3', { sessionId: 'flt', source: 'sdk', timestamp: 3000 } as any),
        makeEvent('e4', { sessionId: 'flt', source: 'sdk', timestamp: 4000 } as any),
        makeEvent('e5', { sessionId: 'flt', source: 'log', timestamp: 5000 } as any),
      ]);
    });

    it('filters by source', async () => {
      const events = await storage.getEvents('flt', { source: ['sdk'] });
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.source === 'sdk')).toBe(true);
    });

    it('filters by time range', async () => {
      const events = await storage.getEvents('flt', { fromTime: 2000, toTime: 4000 });
      expect(events).toHaveLength(3);
    });

    it('applies limit', async () => {
      const events = await storage.getEvents('flt', { limit: 2 });
      expect(events).toHaveLength(2);
    });

    it('applies offset', async () => {
      const events = await storage.getEvents('flt', { offset: 3 });
      expect(events).toHaveLength(2);
    });

    it('applies limit + offset together', async () => {
      const events = await storage.getEvents('flt', { limit: 2, offset: 1 });
      expect(events).toHaveLength(2);
    });
  });

  // ── Concurrent write safety ──

  describe('write lock serialization', () => {
    it('concurrent appends do not interleave', async () => {
      await storage.saveSession(makeSession('conc'));
      const N = 20;
      const promises = Array.from({ length: N }, (_, i) =>
        storage.appendEvent('conc', makeEvent(`e${i}`, { sessionId: 'conc' })),
      );
      await Promise.all(promises);
      const count = await storage.getEventCount('conc');
      expect(count).toBe(N);
    });
  });

  // ── Lifecycle ──

  describe('lifecycle', () => {
    it('initialize creates base directory', async () => {
      const newPath = join(basePath, 'fresh', 'nested');
      const fresh = new FileStorageAdapter(newPath);
      await fresh.initialize();
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(join(newPath, 'sessions'));
      expect(entries).toEqual([]);
      await fresh.close();
    });
  });
});
