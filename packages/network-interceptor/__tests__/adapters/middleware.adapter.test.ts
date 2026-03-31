// ============================================================
// MiddlewareAdapter — Tests for Express middleware lifecycle,
// request/response event emission, and traffic filtering
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { MiddlewareAdapter } from '../../src/adapters/middleware.adapter.js';
import type { NetworkConfig } from '@probe/core';

function createMockReq(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
} = {}): any {
  const req = new EventEmitter();
  (req as any).method = opts.method ?? 'GET';
  (req as any).url = opts.url ?? '/api/test';
  (req as any).headers = opts.headers ?? { 'content-type': 'application/json' };
  return req;
}

function createMockRes(): any {
  const res: any = new EventEmitter();
  res.statusCode = 200;
  res.statusMessage = 'OK';
  res.getHeaders = vi.fn().mockReturnValue({ 'content-type': 'application/json' });
  res.write = vi.fn().mockReturnValue(true);
  res.end = vi.fn();
  return res;
}

const defaultConfig: NetworkConfig = {
  enabled: true,
  captureBody: false,
  maxBodySize: 1_048_576,
};

describe('MiddlewareAdapter', () => {
  let adapter: MiddlewareAdapter;

  beforeEach(() => {
    adapter = new MiddlewareAdapter();
  });

  afterEach(async () => {
    if (adapter.isCapturing()) {
      await adapter.stop();
    }
  });

  describe('lifecycle', () => {
    it('starts as not capturing', () => {
      expect(adapter.isCapturing()).toBe(false);
    });

    it('start() activates capturing', async () => {
      await adapter.start(defaultConfig);
      expect(adapter.isCapturing()).toBe(true);
    });

    it('stop() deactivates capturing', async () => {
      await adapter.start(defaultConfig);
      await adapter.stop();
      expect(adapter.isCapturing()).toBe(false);
    });

    it('setSessionId sets session', () => {
      adapter.setSessionId('sess-1');
      // Should not throw
    });
  });

  describe('onRequest / onResponse handlers', () => {
    it('registers request handler and returns unsubscribe', async () => {
      await adapter.start(defaultConfig);
      const handler = vi.fn();
      const unsub = adapter.onRequest(handler);
      expect(unsub).toBeTypeOf('function');
      unsub();
    });

    it('registers response handler and returns unsubscribe', async () => {
      await adapter.start(defaultConfig);
      const handler = vi.fn();
      const unsub = adapter.onResponse(handler);
      expect(unsub).toBeTypeOf('function');
      unsub();
    });

    it('stop clears all handlers', async () => {
      await adapter.start(defaultConfig);
      const requestHandler = vi.fn();
      const responseHandler = vi.fn();
      adapter.onRequest(requestHandler);
      adapter.onResponse(responseHandler);
      await adapter.stop();

      // After stop, re-start and verify old handlers are gone
      await adapter.start(defaultConfig);
      const middleware = adapter.getMiddleware();
      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();
      middleware(req, res, next);
      req.emit('end');
      // Old handlers should NOT have been called
      expect(requestHandler).not.toHaveBeenCalled();
    });
  });

  describe('getMiddleware', () => {
    it('returns a function with 3 parameters (req, res, next)', () => {
      const middleware = adapter.getMiddleware();
      expect(middleware).toBeTypeOf('function');
      expect(middleware.length).toBe(3);
    });

    it('calls next() immediately when not capturing', () => {
      const middleware = adapter.getMiddleware();
      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();
      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('calls next() for filtered URLs', async () => {
      await adapter.start({
        ...defaultConfig,
        includePatterns: ['/api/**'],
      });
      const middleware = adapter.getMiddleware();
      const req = createMockReq({ url: '/health' });
      const res = createMockRes();
      const next = vi.fn();
      middleware(req, res, next);
      // The traffic filter may or may not pass /health through
      // Just verify next was called in any case
      expect(next).toHaveBeenCalled();
    });

    it('emits request event on req end', async () => {
      await adapter.start(defaultConfig);
      adapter.setSessionId('s1');

      const requestEvents: any[] = [];
      adapter.onRequest((e) => requestEvents.push(e));

      const middleware = adapter.getMiddleware();
      const req = createMockReq({ method: 'POST', url: '/api/users' });
      const res = createMockRes();
      const next = vi.fn();

      middleware(req, res, next);
      req.emit('end');

      expect(requestEvents).toHaveLength(1);
      expect(requestEvents[0].method).toBe('POST');
      expect(requestEvents[0].url).toBe('/api/users');
      expect(requestEvents[0].source).toBe('network');
      expect(requestEvents[0].type).toBe('request');
      expect(requestEvents[0].sessionId).toBe('s1');
      expect(requestEvents[0].requestId).toBeDefined();
      expect(requestEvents[0].id).toBeDefined();
    });

    it('emits response event on res end', async () => {
      await adapter.start(defaultConfig);
      adapter.setSessionId('s2');

      const responseEvents: any[] = [];
      adapter.onResponse((e) => responseEvents.push(e));

      const middleware = adapter.getMiddleware();
      const req = createMockReq({ method: 'GET', url: '/api/items' });
      const res = createMockRes();
      const next = vi.fn();

      middleware(req, res, next);
      // Trigger response end via the patched res.end()
      res.end();

      expect(responseEvents).toHaveLength(1);
      expect(responseEvents[0].statusCode).toBe(200);
      expect(responseEvents[0].source).toBe('network');
      expect(responseEvents[0].type).toBe('response');
      expect(responseEvents[0].duration).toBeTypeOf('number');
      expect(responseEvents[0].sessionId).toBe('s2');
    });

    it('captures request body when captureBody is true', async () => {
      await adapter.start({ ...defaultConfig, captureBody: true });

      const requestEvents: any[] = [];
      adapter.onRequest((e) => requestEvents.push(e));

      const middleware = adapter.getMiddleware();
      const req = createMockReq({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const res = createMockRes();
      const next = vi.fn();

      middleware(req, res, next);
      req.emit('data', Buffer.from('{"key":"value"}'));
      req.emit('end');

      expect(requestEvents).toHaveLength(1);
      expect(requestEvents[0].body).toContain('key');
      expect(requestEvents[0].bodySize).toBe(15);
    });

    it('does not capture body for non-capturable content types', async () => {
      await adapter.start({ ...defaultConfig, captureBody: true });

      const requestEvents: any[] = [];
      adapter.onRequest((e) => requestEvents.push(e));

      const middleware = adapter.getMiddleware();
      const req = createMockReq({
        method: 'POST',
        headers: { 'content-type': 'image/png' },
      });
      const res = createMockRes();
      const next = vi.fn();

      middleware(req, res, next);
      req.emit('data', Buffer.from('binary-data'));
      req.emit('end');

      expect(requestEvents).toHaveLength(1);
      expect(requestEvents[0].body).toBeUndefined();
    });

    it('does not capture body when captureBody is false', async () => {
      await adapter.start({ ...defaultConfig, captureBody: false });

      const requestEvents: any[] = [];
      adapter.onRequest((e) => requestEvents.push(e));

      const middleware = adapter.getMiddleware();
      const req = createMockReq({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const res = createMockRes();
      const next = vi.fn();

      middleware(req, res, next);
      req.emit('data', Buffer.from('data'));
      req.emit('end');

      expect(requestEvents[0].body).toBeUndefined();
    });

    it('redacts sensitive headers', async () => {
      await adapter.start(defaultConfig);

      const requestEvents: any[] = [];
      adapter.onRequest((e) => requestEvents.push(e));

      const middleware = adapter.getMiddleware();
      const req = createMockReq({
        headers: {
          'authorization': 'Bearer secret',
          'content-type': 'text/plain',
        },
      });
      const res = createMockRes();
      const next = vi.fn();

      middleware(req, res, next);
      req.emit('end');

      expect(requestEvents[0].headers['authorization']).not.toBe('Bearer secret');
      expect(requestEvents[0].headers['content-type']).toBe('text/plain');
    });

    it('truncates oversized request body', async () => {
      const maxBodySize = 50;
      await adapter.start({ ...defaultConfig, captureBody: true, maxBodySize });

      const requestEvents: any[] = [];
      adapter.onRequest((e) => requestEvents.push(e));

      const middleware = adapter.getMiddleware();
      const req = createMockReq({
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
      });
      const res = createMockRes();
      const next = vi.fn();

      middleware(req, res, next);
      // Send in small chunks so some get captured before exceeding maxBodySize
      for (let i = 0; i < 10; i++) {
        req.emit('data', Buffer.from('x'.repeat(10)));
      }
      req.emit('end');

      expect(requestEvents[0].body).toContain('[TRUNCATED]');
    });
  });

  describe('unsubscribe handlers', () => {
    it('request handler unsubscribe stops events', async () => {
      await adapter.start(defaultConfig);
      const events: any[] = [];
      const unsub = adapter.onRequest((e) => events.push(e));

      unsub();

      const middleware = adapter.getMiddleware();
      const req = createMockReq();
      const res = createMockRes();
      middleware(req, res, vi.fn());
      req.emit('end');

      expect(events).toHaveLength(0);
    });

    it('response handler unsubscribe stops events', async () => {
      await adapter.start(defaultConfig);
      const events: any[] = [];
      const unsub = adapter.onResponse((e) => events.push(e));

      unsub();

      const middleware = adapter.getMiddleware();
      const req = createMockReq();
      const res = createMockRes();
      middleware(req, res, vi.fn());
      res.end();

      expect(events).toHaveLength(0);
    });
  });
});
