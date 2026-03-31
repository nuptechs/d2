// ============================================================
// Fetch Interceptor — Tests for correlation header injection,
// request-start/end events, error handling, and restore
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installFetchInterceptor } from '../../src/browser/fetch-interceptor.js';

describe('installFetchInterceptor', () => {
  const originalFetch = globalThis.fetch;
  let restore: (() => void) | null = null;

  afterEach(() => {
    if (restore) {
      restore();
      restore = null;
    }
    globalThis.fetch = originalFetch;
  });

  it('returns no-op restore when fetch is not available', () => {
    const saved = globalThis.fetch;
    (globalThis as any).fetch = undefined;

    const events: any[] = [];
    const fn = installFetchInterceptor({
      correlationHeader: 'x-corr',
      correlationId: 'abc',
      onEvent: (e) => events.push(e),
    });

    expect(fn).toBeTypeOf('function');
    fn(); // Should not throw

    globalThis.fetch = saved;
  });

  it('injects correlation header into outgoing requests', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    globalThis.fetch = mockFetch;

    const events: any[] = [];
    restore = installFetchInterceptor({
      correlationHeader: 'x-correlation-id',
      correlationId: 'corr-123',
      onEvent: (e) => events.push(e),
    });

    await globalThis.fetch('https://example.com/api');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0];
    const headers = callArgs[1]?.headers;
    expect(headers).toBeDefined();
    // Headers object
    if (headers instanceof Headers) {
      expect(headers.get('x-correlation-id')).toBe('corr-123');
    }
  });

  it('emits request-start and request-end events on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));

    const events: any[] = [];
    restore = installFetchInterceptor({
      correlationHeader: 'x-corr',
      correlationId: 'c1',
      onEvent: (e) => events.push(e),
    });

    await globalThis.fetch('https://example.com/test');

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('request-start');
    expect(events[0].url).toBe('https://example.com/test');
    expect(events[0].method).toBe('GET');
    expect(events[0].source).toBe('sdk');
    expect(events[0].requestId).toBeDefined();

    expect(events[1].type).toBe('request-end');
    expect(events[1].statusCode).toBe(200);
    expect(events[1].duration).toBeTypeOf('number');
    expect(events[1].requestId).toBe(events[0].requestId);
  });

  it('emits request-end with error on fetch failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network failure'));

    const events: any[] = [];
    restore = installFetchInterceptor({
      correlationHeader: 'x-corr',
      correlationId: 'c2',
      onEvent: (e) => events.push(e),
    });

    await expect(globalThis.fetch('https://fail.com')).rejects.toThrow('Network failure');

    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('request-end');
    expect(events[1].statusCode).toBe(0);
    expect(events[1].error).toBe('Network failure');
  });

  it('resolves method from init', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 201 }));

    const events: any[] = [];
    restore = installFetchInterceptor({
      correlationHeader: 'x-corr',
      onEvent: (e) => events.push(e),
    });

    await globalThis.fetch('https://example.com/data', { method: 'POST' });

    expect(events[0].method).toBe('POST');
  });

  it('resolves URL from URL object', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));

    const events: any[] = [];
    restore = installFetchInterceptor({
      correlationHeader: 'x-corr',
      onEvent: (e) => events.push(e),
    });

    await globalThis.fetch(new URL('https://example.com/path'));

    expect(events[0].url).toBe('https://example.com/path');
  });

  it('does not inject header when correlationId is not set', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    globalThis.fetch = mockFetch;

    const events: any[] = [];
    restore = installFetchInterceptor({
      correlationHeader: 'x-corr',
      // no correlationId
      onEvent: (e) => events.push(e),
    });

    await globalThis.fetch('https://example.com');

    const callArgs = mockFetch.mock.calls[0];
    const headers = callArgs[1]?.headers;
    if (headers instanceof Headers) {
      expect(headers.has('x-corr')).toBe(false);
    }
  });

  it('restore function puts original fetch back', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
    globalThis.fetch = mockFetch;

    const events: any[] = [];
    const restoreFn = installFetchInterceptor({
      correlationHeader: 'x-corr',
      onEvent: (e) => events.push(e),
    });

    // After install, fetch is intercepted
    expect(globalThis.fetch).not.toBe(mockFetch);

    restoreFn();
    restore = null; // Already restored

    expect(globalThis.fetch).toBe(mockFetch);
  });

  it('redacts sensitive headers in events', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));

    const events: any[] = [];
    restore = installFetchInterceptor({
      correlationHeader: 'x-corr',
      correlationId: 'c3',
      onEvent: (e) => events.push(e),
    });

    await globalThis.fetch('https://example.com', {
      headers: { 'Authorization': 'Bearer secret-token', 'Content-Type': 'application/json' },
    });

    const startEvent = events[0];
    expect(startEvent.headers?.['authorization']).not.toBe('Bearer secret-token');
    expect(startEvent.headers?.['content-type']).toBe('application/json');
  });

  it('increments request counter for unique requestIds', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok'));

    const events: any[] = [];
    restore = installFetchInterceptor({
      correlationHeader: 'x-corr',
      onEvent: (e) => events.push(e),
    });

    await globalThis.fetch('https://example.com/1');
    await globalThis.fetch('https://example.com/2');

    const id1 = events[0].requestId;
    const id2 = events[2].requestId;
    expect(id1).not.toBe(id2);
  });
});
