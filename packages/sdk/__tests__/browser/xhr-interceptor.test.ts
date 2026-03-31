// ============================================================
// XHR Interceptor — Tests for open/send patching,
// correlation header injection, event emission, restore
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installXhrInterceptor } from '../../src/browser/xhr-interceptor.js';

// Minimal XMLHttpRequest mock for Node.js environment
class MockXMLHttpRequest {
  status = 0;
  readyState = 0;
  private _listeners: Record<string, Function[]> = {};
  private _headers: Record<string, string> = {};
  private _method = '';
  private _url = '';

  open(method: string, url: string | URL, async?: boolean, user?: string | null, password?: string | null): void {
    this._method = method;
    this._url = typeof url === 'string' ? url : url.href;
  }

  send(body?: any): void {
    // no-op by default
  }

  setRequestHeader(name: string, value: string): void {
    this._headers[name] = value;
  }

  addEventListener(event: string, handler: Function): void {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
  }

  removeEventListener(event: string, handler: Function): void {
    if (this._listeners[event]) {
      this._listeners[event] = this._listeners[event].filter(h => h !== handler);
    }
  }

  // Helper to simulate events in tests
  _emit(event: string): void {
    for (const handler of this._listeners[event] ?? []) {
      handler();
    }
  }

  getRequestHeaders(): Record<string, string> {
    return { ...this._headers };
  }
}

// Install global XMLHttpRequest before tests
const originalXHR = globalThis.XMLHttpRequest;

beforeEach(() => {
  (globalThis as any).XMLHttpRequest = MockXMLHttpRequest;
  // Mock performance.now for duration tracking
  vi.spyOn(performance, 'now').mockReturnValue(1000);
});

afterEach(() => {
  (globalThis as any).XMLHttpRequest = originalXHR;
  vi.restoreAllMocks();
});

describe('installXhrInterceptor', () => {
  it('patches open and send on prototype', () => {
    const origOpen = MockXMLHttpRequest.prototype.open;
    const origSend = MockXMLHttpRequest.prototype.send;

    const restore = installXhrInterceptor({
      correlationHeader: 'x-corr',
      onEvent: () => {},
    });

    expect(MockXMLHttpRequest.prototype.open).not.toBe(origOpen);
    expect(MockXMLHttpRequest.prototype.send).not.toBe(origSend);

    restore();

    expect(MockXMLHttpRequest.prototype.open).toBe(origOpen);
    expect(MockXMLHttpRequest.prototype.send).toBe(origSend);
  });

  it('injects correlation header', () => {
    const events: any[] = [];
    const restore = installXhrInterceptor({
      correlationHeader: 'x-correlation-id',
      correlationId: 'corr-456',
      onEvent: (e) => events.push(e),
    });

    const xhr = new MockXMLHttpRequest() as any;
    xhr.open('GET', 'https://example.com/api');
    xhr.send();

    // Check that the header was injected
    expect(xhr.getRequestHeaders()['x-correlation-id']).toBe('corr-456');

    restore();
  });

  it('emits request-start on send', () => {
    const events: any[] = [];
    const restore = installXhrInterceptor({
      correlationHeader: 'x-corr',
      correlationId: 'c1',
      onEvent: (e) => events.push(e),
    });

    const xhr = new MockXMLHttpRequest() as any;
    xhr.open('POST', 'https://example.com/data');
    xhr.send('body');

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('request-start');
    expect(events[0].source).toBe('sdk');
    expect(events[0].method).toBe('POST');
    expect(events[0].url).toBe('https://example.com/data');
    expect(events[0].requestId).toMatch(/^browser-xhr-/);

    restore();
  });

  it('emits request-end on load', () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(1000)  // read at open time (not used)
      .mockReturnValueOnce(1000)  // startTime in send
      .mockReturnValueOnce(1250); // duration calc in emitEnd

    const events: any[] = [];
    const restore = installXhrInterceptor({
      correlationHeader: 'x-corr',
      onEvent: (e) => events.push(e),
    });

    const xhr = new MockXMLHttpRequest() as any;
    xhr.open('GET', 'https://example.com');
    xhr.send();

    xhr.status = 200;
    xhr._emit('load');

    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('request-end');
    expect(events[1].statusCode).toBe(200);
    expect(events[1].duration).toBeTypeOf('number');

    restore();
  });

  it('emits request-end with error on network error', () => {
    const events: any[] = [];
    const restore = installXhrInterceptor({
      correlationHeader: 'x-corr',
      onEvent: (e) => events.push(e),
    });

    const xhr = new MockXMLHttpRequest() as any;
    xhr.open('GET', 'https://fail.com');
    xhr.send();

    xhr._emit('error');

    const endEvent = events.find((e) => e.type === 'request-end');
    expect(endEvent).toBeDefined();
    expect(endEvent.error).toBe('Network error');
    expect(endEvent.statusCode).toBe(0);

    restore();
  });

  it('emits request-end with abort message', () => {
    const events: any[] = [];
    const restore = installXhrInterceptor({
      correlationHeader: 'x-corr',
      onEvent: (e) => events.push(e),
    });

    const xhr = new MockXMLHttpRequest() as any;
    xhr.open('GET', 'https://example.com');
    xhr.send();

    xhr._emit('abort');

    const endEvent = events.find((e) => e.type === 'request-end');
    expect(endEvent.error).toBe('Request aborted');

    restore();
  });

  it('emits request-end with timeout message', () => {
    const events: any[] = [];
    const restore = installXhrInterceptor({
      correlationHeader: 'x-corr',
      onEvent: (e) => events.push(e),
    });

    const xhr = new MockXMLHttpRequest() as any;
    xhr.open('GET', 'https://slow.com');
    xhr.send();

    xhr._emit('timeout');

    const endEvent = events.find((e) => e.type === 'request-end');
    expect(endEvent.error).toBe('Request timed out');

    restore();
  });

  it('does not inject header when correlationId is not set', () => {
    const events: any[] = [];
    const restore = installXhrInterceptor({
      correlationHeader: 'x-corr',
      // no correlationId
      onEvent: (e) => events.push(e),
    });

    const xhr = new MockXMLHttpRequest() as any;
    xhr.open('GET', 'https://example.com');
    xhr.send();

    expect(xhr.getRequestHeaders()['x-corr']).toBeUndefined();

    restore();
  });

  it('uppercases method stored in metadata', () => {
    const events: any[] = [];
    const restore = installXhrInterceptor({
      correlationHeader: 'x-corr',
      onEvent: (e) => events.push(e),
    });

    const xhr = new MockXMLHttpRequest() as any;
    xhr.open('post', 'https://example.com');
    xhr.send();

    expect(events[0].method).toBe('POST');

    restore();
  });

  it('generates unique requestIds per instance', () => {
    const events: any[] = [];
    const restore = installXhrInterceptor({
      correlationHeader: 'x-corr',
      onEvent: (e) => events.push(e),
    });

    const xhr1 = new MockXMLHttpRequest() as any;
    xhr1.open('GET', 'https://example.com/1');
    xhr1.send();

    const xhr2 = new MockXMLHttpRequest() as any;
    xhr2.open('GET', 'https://example.com/2');
    xhr2.send();

    expect(events[0].requestId).not.toBe(events[1].requestId);

    restore();
  });

  it('removes event listeners after completion', () => {
    const events: any[] = [];
    const restore = installXhrInterceptor({
      correlationHeader: 'x-corr',
      onEvent: (e) => events.push(e),
    });

    const xhr = new MockXMLHttpRequest() as any;
    xhr.open('GET', 'https://example.com');
    xhr.send();

    xhr.status = 200;
    xhr._emit('load');

    // Emitting again should not produce another event
    xhr._emit('load');
    const endEvents = events.filter((e) => e.type === 'request-end');
    expect(endEvents).toHaveLength(1);

    restore();
  });
});
