// ============================================================
// PostgresStorageAdapter — Unit tests (mocked pg Pool)
// StorageCircuitBreaker + isTransientError + adapter CRUD
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  StorageCircuitBreaker,
  isTransientError,
  PostgresStorageAdapter,
} from '../../src/storage/postgres-storage.adapter.js';

// ---- StorageCircuitBreaker ----

describe('StorageCircuitBreaker', () => {
  it('starts in closed state', () => {
    const cb = new StorageCircuitBreaker();
    expect(cb.getState()).toBe('closed');
  });

  it('stays closed after successful executions', async () => {
    const cb = new StorageCircuitBreaker({ failureThreshold: 3 });
    await cb.execute(() => Promise.resolve('ok'));
    await cb.execute(() => Promise.resolve('ok'));
    expect(cb.getState()).toBe('closed');
  });

  it('opens after reaching failure threshold', async () => {
    const cb = new StorageCircuitBreaker({ failureThreshold: 2 });
    const fail = () => Promise.reject(new Error('fail'));

    await expect(cb.execute(fail)).rejects.toThrow('fail');
    expect(cb.getState()).toBe('closed');
    await expect(cb.execute(fail)).rejects.toThrow('fail');
    expect(cb.getState()).toBe('open');
  });

  it('rejects calls when open', async () => {
    const cb = new StorageCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });
    await expect(cb.execute(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(cb.getState()).toBe('open');

    await expect(cb.execute(() => Promise.resolve('ok'))).rejects.toThrow(
      'Circuit breaker is open',
    );
  });

  it('transitions to half-open after reset timeout', async () => {
    const cb = new StorageCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 2,
    });

    await expect(cb.execute(() => Promise.reject(new Error('x')))).rejects.toThrow();
    expect(cb.getState()).toBe('open');

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 60));

    // Next call transitions to half-open and succeeds → closed
    const result = await cb.execute(() => Promise.resolve('recovered'));
    expect(result).toBe('recovered');
    expect(cb.getState()).toBe('closed');
  });

  it('returns to open from half-open on failure', async () => {
    const cb = new StorageCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 2,
    });

    await expect(cb.execute(() => Promise.reject(new Error('x')))).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 60));

    // half-open → failure → back to open
    await expect(cb.execute(() => Promise.reject(new Error('y')))).rejects.toThrow('y');
    expect(cb.getState()).toBe('open');
  });

  it('rejects after halfOpenMaxAttempts', async () => {
    const cb = new StorageCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });

    await expect(cb.execute(() => Promise.reject(new Error('x')))).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 60));

    // First half-open attempt (within limit) — succeeds
    let callCount = 0;
    await cb.execute(() => {
      callCount++;
      return Promise.resolve('ok');
    });
    expect(callCount).toBe(1);
    expect(cb.getState()).toBe('closed'); // success resets
  });

  it('resets failure count on success in closed state', async () => {
    const cb = new StorageCircuitBreaker({ failureThreshold: 3 });
    const fail = () => Promise.reject(new Error('fail'));

    await expect(cb.execute(fail)).rejects.toThrow();
    await expect(cb.execute(fail)).rejects.toThrow();
    // 2 failures, then success resets
    await cb.execute(() => Promise.resolve('ok'));
    expect(cb.getState()).toBe('closed');

    // Need 3 more failures to open
    await expect(cb.execute(fail)).rejects.toThrow();
    await expect(cb.execute(fail)).rejects.toThrow();
    expect(cb.getState()).toBe('closed');
    await expect(cb.execute(fail)).rejects.toThrow();
    expect(cb.getState()).toBe('open');
  });
});

// ---- isTransientError ----

describe('isTransientError', () => {
  it('returns false for non-Error values', () => {
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError('string')).toBe(false);
    expect(isTransientError(42)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });

  it('returns true for ECONNREFUSED', () => {
    const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    expect(isTransientError(err)).toBe(true);
  });

  it('returns true for ECONNRESET', () => {
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    expect(isTransientError(err)).toBe(true);
  });

  it('returns true for ETIMEDOUT', () => {
    const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    expect(isTransientError(err)).toBe(true);
  });

  it('returns true for serialization_failure (40001)', () => {
    const err = Object.assign(new Error('srl'), { code: '40001' });
    expect(isTransientError(err)).toBe(true);
  });

  it('returns true for deadlock_detected (40P01)', () => {
    const err = Object.assign(new Error('deadlock'), { code: '40P01' });
    expect(isTransientError(err)).toBe(true);
  });

  it('returns true for admin_shutdown (57P01)', () => {
    const err = Object.assign(new Error('shutdown'), { code: '57P01' });
    expect(isTransientError(err)).toBe(true);
  });

  it('returns true for cannot_connect_now (57P03)', () => {
    const err = Object.assign(new Error('recovery'), { code: '57P03' });
    expect(isTransientError(err)).toBe(true);
  });

  it('returns true for "Connection terminated" message', () => {
    expect(isTransientError(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  it('returns true for "server closed the connection" message', () => {
    expect(isTransientError(new Error('server closed the connection unexpectedly'))).toBe(true);
  });

  it('returns false for regular errors', () => {
    expect(isTransientError(new Error('syntax error'))).toBe(false);
    expect(isTransientError(new Error('unique constraint violation'))).toBe(false);
  });

  it('returns false for Errors with non-transient codes', () => {
    const err = Object.assign(new Error('bad'), { code: '23505' });
    expect(isTransientError(err)).toBe(false);
  });
});

// ---- PostgresStorageAdapter (mocked Pool) ----

function createMockPool() {
  const mockClient = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn().mockResolvedValue(mockClient),
    end: vi.fn().mockResolvedValue(undefined),
  };
  return { pool, mockClient };
}

function createInitializedAdapter(mockPool: ReturnType<typeof createMockPool>['pool']) {
  const adapter = new PostgresStorageAdapter({ connectionString: 'postgres://test' });
  // Inject mock pool via the private field
  (adapter as any).pool = mockPool;
  return adapter;
}

const sampleSession = {
  id: 'sess-1',
  name: 'Test Session',
  status: 'idle' as const,
  config: {
    browser: { enabled: true, captureClicks: true, captureNavigation: true, captureConsole: true, captureErrors: true },
    logs: { enabled: true, sources: [] },
    network: { enabled: false },
    sdk: { enabled: false },
    correlation: { enabled: true, strategies: ['request-id' as const], maxGroupAge: 60000 },
    capture: { maxEvents: 10000, maxDuration: 300000 },
  },
  startedAt: 1000,
  eventCount: 0,
};

const sampleEvent = {
  id: 'evt-1',
  sessionId: 'sess-1',
  timestamp: 2000,
  source: 'browser' as const,
  type: 'click',
};

describe('PostgresStorageAdapter', () => {
  let pool: ReturnType<typeof createMockPool>['pool'];
  let mockClient: ReturnType<typeof createMockPool>['mockClient'];
  let adapter: PostgresStorageAdapter;

  beforeEach(() => {
    const mock = createMockPool();
    pool = mock.pool;
    mockClient = mock.mockClient;
    adapter = createInitializedAdapter(pool);
  });

  describe('getPool guard', () => {
    it('throws if not initialized', async () => {
      const raw = new PostgresStorageAdapter({ connectionString: 'x' });
      await expect(raw.saveSession(sampleSession)).rejects.toThrow('not initialized');
    });
  });

  describe('close', () => {
    it('calls pool.end()', async () => {
      await adapter.close();
      expect(pool.end).toHaveBeenCalled();
    });

    it('is safe to call when no pool', async () => {
      const raw = new PostgresStorageAdapter({ connectionString: 'x' });
      await raw.close(); // Should not throw
    });
  });

  describe('saveSession', () => {
    it('executes upsert query with correct params', async () => {
      await adapter.saveSession(sampleSession);

      expect(pool.query).toHaveBeenCalledTimes(1);
      const call = pool.query.mock.calls[0];
      expect(call[0]).toContain('INSERT INTO probe_sessions');
      expect(call[0]).toContain('ON CONFLICT (id) DO UPDATE');
      expect(call[1][0]).toBe('sess-1');
      expect(call[1][1]).toBe('Test Session');
      expect(call[1][2]).toBe('idle');
    });
  });

  describe('loadSession', () => {
    it('returns null when no rows', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });
      const result = await adapter.loadSession('nonexistent');
      expect(result).toBeNull();
    });

    it('maps row to DebugSession', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: 'sess-1',
          name: 'My Session',
          status: 'running',
          config: { browser: { enabled: true } },
          started_at: 1000,
          ended_at: null,
          event_count: 5,
          error_message: undefined,
          tags: ['tag1'],
          metadata: { key: 'value' },
        }],
      });
      const session = await adapter.loadSession('sess-1');
      expect(session).not.toBeNull();
      expect(session!.id).toBe('sess-1');
      expect(session!.name).toBe('My Session');
      expect(session!.status).toBe('running');
      expect(session!.startedAt).toBe(1000);
      expect(session!.eventCount).toBe(5);
      expect(session!.tags).toEqual(['tag1']);
    });

    it('parses JSON string config', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: 'sess-2',
          name: 'S',
          status: 'idle',
          config: JSON.stringify({ browser: { enabled: false } }),
          started_at: 100,
          ended_at: null,
          event_count: 0,
        }],
      });
      const session = await adapter.loadSession('sess-2');
      expect(session!.config.browser.enabled).toBe(false);
    });
  });

  describe('listSessions', () => {
    it('returns mapped sessions ordered by started_at DESC', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          { id: 's1', name: 'A', status: 'idle', config: {}, started_at: 200, ended_at: null, event_count: 0 },
          { id: 's2', name: 'B', status: 'idle', config: {}, started_at: 100, ended_at: null, event_count: 0 },
        ],
      });
      const sessions = await adapter.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe('s1');
    });
  });

  describe('deleteSession', () => {
    it('executes DELETE query', async () => {
      await adapter.deleteSession('sess-1');
      expect(pool.query).toHaveBeenCalledTimes(1);
      const call = pool.query.mock.calls[0];
      expect(call[0]).toContain('DELETE FROM probe_sessions');
      expect(call[1]).toEqual(['sess-1']);
    });
  });

  describe('updateSessionStatus', () => {
    it('updates status without patch', async () => {
      await adapter.updateSessionStatus('sess-1', 'running');
      expect(pool.query).toHaveBeenCalledTimes(1);
      const call = pool.query.mock.calls[0];
      expect(call[0]).toContain('UPDATE probe_sessions SET');
      expect(call[1][0]).toBe('sess-1');
      expect(call[1][1]).toBe('running');
    });

    it('sets ended_at when status is completed', async () => {
      const before = Date.now();
      await adapter.updateSessionStatus('sess-1', 'completed');
      const call = pool.query.mock.calls[0];
      const endedAt = call[1][2];
      expect(endedAt).toBeGreaterThanOrEqual(before);
    });

    it('sets ended_at when status is error', async () => {
      await adapter.updateSessionStatus('sess-1', 'error');
      const call = pool.query.mock.calls[0];
      expect(call[1][2]).toBeTypeOf('number');
    });

    it('does not set ended_at for running status', async () => {
      await adapter.updateSessionStatus('sess-1', 'running');
      const call = pool.query.mock.calls[0];
      expect(call[1][2]).toBeNull();
    });

    it('applies patch fields when provided', async () => {
      await adapter.updateSessionStatus('sess-1', 'error', {
        name: 'Updated',
        errorMessage: 'boom',
        eventCount: 42,
      });
      expect(pool.query).toHaveBeenCalledTimes(1);
      const call = pool.query.mock.calls[0];
      expect(call[0]).toContain('COALESCE');
      expect(call[1]).toContain('Updated');
      expect(call[1]).toContain('boom');
      expect(call[1]).toContain(42);
    });
  });

  describe('appendEvents', () => {
    it('skips when events array is empty', async () => {
      await adapter.appendEvents('sess-1', []);
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('inserts events with UNNEST and updates session count', async () => {
      await adapter.appendEvents('sess-1', [sampleEvent]);
      // Two queries: INSERT + UPDATE event count
      expect(pool.query).toHaveBeenCalledTimes(2);

      const insertCall = pool.query.mock.calls[0];
      expect(insertCall[0]).toContain('INSERT INTO probe_events');
      expect(insertCall[0]).toContain('UNNEST');
      expect(insertCall[1][0]).toEqual(['evt-1']); // ids array
      expect(insertCall[1][1]).toEqual(['sess-1']); // sessionIds

      const updateCall = pool.query.mock.calls[1];
      expect(updateCall[0]).toContain('UPDATE probe_sessions SET event_count');
    });
  });

  describe('appendEvent', () => {
    it('delegates to appendEvents', async () => {
      await adapter.appendEvent('sess-1', sampleEvent);
      expect(pool.query).toHaveBeenCalledTimes(2);
    });
  });

  describe('getEvents', () => {
    it('returns events from payload column', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ payload: sampleEvent }, { payload: { ...sampleEvent, id: 'evt-2' } }],
      });
      const events = await adapter.getEvents('sess-1');
      expect(events).toHaveLength(2);
      expect(events[0].id).toBe('evt-1');
    });

    it('applies filters to query', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });
      await adapter.getEvents('sess-1', {
        source: ['browser'],
        types: ['click'],
        fromTime: 1000,
        toTime: 2000,
        correlationId: 'corr-1',
        limit: 10,
        offset: 5,
      });
      const call = pool.query.mock.calls[0];
      expect(call[0]).toContain('source = ANY');
      expect(call[0]).toContain('type = ANY');
      expect(call[0]).toContain('timestamp >=');
      expect(call[0]).toContain('timestamp <=');
      expect(call[0]).toContain('correlation_id =');
    });
  });

  describe('getEventCount', () => {
    it('returns count from query', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ count: 42 }] });
      const count = await adapter.getEventCount('sess-1');
      expect(count).toBe(42);
    });

    it('returns 0 when no rows', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{}] });
      const count = await adapter.getEventCount('sess-1');
      expect(count).toBe(0);
    });
  });

  describe('listSessionsPaginated', () => {
    it('applies status filter', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ total: 1 }] }) // count
        .mockResolvedValueOnce({
          rows: [{ id: 's1', name: 'A', status: 'running', config: {}, started_at: 100, ended_at: null, event_count: 0 }],
        });
      const result = await adapter.listSessionsPaginated({ status: 'running' });
      expect(result.total).toBe(1);
      expect(result.sessions).toHaveLength(1);

      const countCall = pool.query.mock.calls[0];
      expect(countCall[0]).toContain('status = $1');
    });

    it('applies search filter with ILIKE', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ total: 0 }] })
        .mockResolvedValueOnce({ rows: [] });
      await adapter.listSessionsPaginated({ search: 'test%' });

      const countCall = pool.query.mock.calls[0];
      expect(countCall[0]).toContain('ILIKE');
      // Should escape % in user input
      expect(countCall[1]).toContain('%test\\%%');
    });

    it('clamps limit to 200', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ total: 0 }] })
        .mockResolvedValueOnce({ rows: [] });
      await adapter.listSessionsPaginated({ limit: 999 });

      const dataCall = pool.query.mock.calls[1];
      const params = dataCall[1];
      // The limit param should be clamped to 200
      expect(params[params.length - 2]).toBe(200);
    });

    it('allows only whitelisted order columns', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ total: 0 }] })
        .mockResolvedValueOnce({ rows: [] });
      // Drop table injection attempt via orderBy
      await adapter.listSessionsPaginated({ orderBy: 'DROP TABLE' });

      const dataCall = pool.query.mock.calls[1];
      // Should fallback to started_at
      expect(dataCall[0]).toContain('ORDER BY started_at');
    });
  });

  describe('getEventsWithTotal', () => {
    it('returns events and total count', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ total: 2 }] })
        .mockResolvedValueOnce({ rows: [{ payload: sampleEvent }] });
      const result = await adapter.getEventsWithTotal('sess-1');
      expect(result.total).toBe(2);
      expect(result.events).toHaveLength(1);
    });

    it('applies all EventFilter fields', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ total: 0 }] })
        .mockResolvedValueOnce({ rows: [] });
      await adapter.getEventsWithTotal('sess-1', {
        source: ['network'],
        types: ['request'],
        fromTime: 100,
        toTime: 200,
        correlationId: 'c-1',
        limit: 10,
        offset: 5,
      });
      const countCall = pool.query.mock.calls[0];
      expect(countCall[0]).toContain('source = ANY');
      expect(countCall[0]).toContain('type = ANY');
      expect(countCall[0]).toContain('correlation_id');
    });
  });
});
