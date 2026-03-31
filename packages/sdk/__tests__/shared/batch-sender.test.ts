import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BatchSender } from '../../src/shared/batch-sender.js';
import type { ProbeEvent } from '@probe/core';
import { generateId, nowMs } from '@probe/core';

function makeEvent(overrides: Partial<ProbeEvent> = {}): ProbeEvent {
  return {
    id: generateId(),
    sessionId: 'sess-test',
    timestamp: nowMs(),
    source: 'sdk',
    ...overrides,
  } as ProbeEvent;
}

describe('BatchSender', () => {
  let sender: BatchSender;

  beforeEach(() => {
    sender = new BatchSender({
      serverUrl: 'http://localhost:3000',
      sessionId: 'test-session',
      maxBatchSize: 5,
      flushIntervalMs: 100_000, // don't auto-flush in tests
      maxRetries: 1,
      retryBackoffMs: 1,
      maxQueueSize: 100,
    });
    // Reset global fetch mock
    vi.restoreAllMocks();
  });

  it('enqueues events to the ring buffer', () => {
    sender.enqueue(makeEvent());
    sender.enqueue(makeEvent());
    const stats = sender.getStats();
    expect(stats.queued).toBe(2);
  });

  it('tracks dropped count when buffer is full', () => {
    const tiny = new BatchSender({
      serverUrl: 'http://localhost:3000',
      sessionId: 'test',
      maxQueueSize: 2,
    });
    tiny.enqueue(makeEvent());
    tiny.enqueue(makeEvent());
    tiny.enqueue(makeEvent()); // evicts oldest
    const stats = tiny.getStats();
    expect(stats.dropped).toBe(1);
    expect(stats.queued).toBe(2);
  });

  it('flush drains events and POSTs as batch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    sender.enqueue(makeEvent());
    sender.enqueue(makeEvent());
    await sender.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/sessions/test-session/events');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.events).toHaveLength(2);
  });

  it('URL-encodes sessionId', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const specialSender = new BatchSender({
      serverUrl: 'http://localhost:3000',
      sessionId: 'session/with spaces',
      maxBatchSize: 5,
    });
    specialSender.enqueue(makeEvent());
    await specialSender.flush();

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('session%2Fwith%20spaces');
  });

  it('no-op when already flushing (reentrancy guard)', async () => {
    let resolveFirst!: () => void;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      return new Promise((resolve) => {
        resolveFirst = () => resolve({ ok: true, status: 200 });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    sender.enqueue(makeEvent());
    const flush1 = sender.flush();
    const flush2 = sender.flush(); // should be no-op (flushing=true)

    resolveFirst();
    await flush1;
    await flush2;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx with backoff', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    sender.enqueue(makeEvent());
    await sender.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sender.getStats().sent).toBe(1);
  });

  it('does NOT retry on 4xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    vi.stubGlobal('fetch', fetchMock);

    sender.enqueue(makeEvent());
    await sender.flush();

    // 4xx returns false from sendBatch → sendBatchWithRetry exits immediately
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sender.getStats().dropped).toBe(1);
  });

  it('getStats reports accurate counts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    sender.enqueue(makeEvent());
    sender.enqueue(makeEvent());
    sender.enqueue(makeEvent());

    const before = sender.getStats();
    expect(before.queued).toBe(3);
    expect(before.sent).toBe(0);

    await sender.flush();

    const after = sender.getStats();
    expect(after.queued).toBe(0);
    expect(after.sent).toBe(3);
  });

  it('respects maxBatchSize limit', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    // Enqueue 12 events, maxBatchSize=5 → should send 3 batches (5+5+2)
    for (let i = 0; i < 12; i++) sender.enqueue(makeEvent());
    await sender.flush();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const batch1 = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(batch1.events).toHaveLength(5);
  });

  it('stop clears timer and performs final flush', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    sender.start();
    sender.enqueue(makeEvent());
    await sender.stop();

    expect(sender.getStats().sent).toBe(1);
  });
});
