// ============================================================
// Express Middleware — Comprehensive tests
// Correlation ID validation, context propagation, events
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createProbeMiddleware,
  getDefaultCollector,
  getProbeContext,
} from '../../src/node/express-middleware.js';
import { SdkEventCollector } from '../../src/node/event-collector.js';
import { getCurrentContext } from '../../src/node/context.js';
import type { SdkConfig } from '@probe/core';

// ── Helpers ───────────────────────────────────────────────────

function makeSdkConfig(overrides?: Partial<SdkConfig>): SdkConfig {
  return {
    enabled: true,
    captureDbQueries: false,
    captureCache: false,
    captureCustomSpans: false,
    correlationHeader: 'x-correlation-id',
    sensitiveHeaders: ['authorization', 'cookie'],
    ...overrides,
  };
}

function mockReq(headers: Record<string, string> = {}, overrides: Record<string, any> = {}): any {
  return {
    method: 'GET',
    url: '/api/test',
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  };
}

function mockRes(): any {
  const responseHeaders: Record<string, string> = {};
  const onListeners: Record<string, (() => void)[]> = {};
  return {
    statusCode: 200,
    setHeader(name: string, value: string) { responseHeaders[name] = value; },
    getHeader(name: string) { return responseHeaders[name]; },
    on(event: string, listener: () => void) {
      (onListeners[event] ??= []).push(listener);
    },
    _trigger(event: string) {
      for (const l of onListeners[event] ?? []) l();
    },
    _headers: responseHeaders,
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe('Express Probe Middleware', () => {
  let collector: SdkEventCollector;

  beforeEach(() => {
    collector = new SdkEventCollector();
    collector.setSessionId('test-session');
  });

  // ── Basic behavior ──

  describe('basic behavior', () => {
    it('calls next() and does not block', () => {
      const mw = createProbeMiddleware({ config: makeSdkConfig(), collector });
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalledOnce();
    });

    it('skips instrumentation when config.enabled is false', () => {
      const events: any[] = [];
      collector.onEvent((e) => events.push(e));
      const mw = createProbeMiddleware({ config: makeSdkConfig({ enabled: false }), collector });
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(events).toHaveLength(0);
    });

    it('emits request-start event on middleware execution', () => {
      const events: any[] = [];
      collector.onEvent((e) => events.push(e));
      const mw = createProbeMiddleware({ config: makeSdkConfig(), collector });
      const req = mockReq({}, { method: 'POST', url: '/api/users' });
      const res = mockRes();
      mw(req, res, vi.fn());
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('request-start');
      expect(events[0].method).toBe('POST');
      expect(events[0].url).toBe('/api/users');
    });

    it('emits request-end event on response finish', () => {
      const events: any[] = [];
      collector.onEvent((e) => events.push(e));
      const mw = createProbeMiddleware({ config: makeSdkConfig(), collector });
      const req = mockReq();
      const res = mockRes();
      res.statusCode = 201;
      mw(req, res, vi.fn());
      res._trigger('finish');
      expect(events).toHaveLength(2);
      const endEvent = events.find((e: any) => e.type === 'request-end');
      expect(endEvent).toBeDefined();
      expect(endEvent.statusCode).toBe(201);
      expect(endEvent.duration).toBeGreaterThanOrEqual(0);
    });

    it('includes error string for 5xx responses', () => {
      const events: any[] = [];
      collector.onEvent((e) => events.push(e));
      const mw = createProbeMiddleware({ config: makeSdkConfig(), collector });
      const req = mockReq();
      const res = mockRes();
      res.statusCode = 503;
      mw(req, res, vi.fn());
      res._trigger('finish');
      const end = events.find((e: any) => e.type === 'request-end');
      expect(end.error).toBe('HTTP 503');
    });
  });

  // ── Correlation ID validation ──

  describe('correlation ID validation', () => {
    it('generates new correlation ID when none provided', () => {
      const events: any[] = [];
      collector.onEvent((e) => events.push(e));
      const mw = createProbeMiddleware({ config: makeSdkConfig(), collector });
      const req = mockReq();
      const res = mockRes();
      mw(req, res, vi.fn());
      expect(events[0].correlationId).toMatch(/^probe-[a-f0-9]{16}$/);
    });

    it('accepts valid incoming correlation ID', () => {
      const events: any[] = [];
      collector.onEvent((e) => events.push(e));
      const mw = createProbeMiddleware({ config: makeSdkConfig(), collector });
      const req = mockReq({ 'x-correlation-id': 'my-valid-id-123' });
      const res = mockRes();
      mw(req, res, vi.fn());
      expect(events[0].correlationId).toBe('my-valid-id-123');
    });

    it('rejects and replaces empty correlation ID', () => {
      const events: any[] = [];
      collector.onEvent((e) => events.push(e));
      const mw = createProbeMiddleware({ config: makeSdkConfig(), collector });
      const req = mockReq({ 'x-correlation-id': '' });
      const res = mockRes();
      mw(req, res, vi.fn());
      expect(events[0].correlationId).toMatch(/^probe-/);
    });

    it('rejects correlation ID exceeding 128 chars', () => {
      const events: any[] = [];
      collector.onEvent((e) => events.push(e));
      const mw = createProbeMiddleware({ config: makeSdkConfig(), collector });
      const longId = 'a'.repeat(200);
      const req = mockReq({ 'x-correlation-id': longId });
      const res = mockRes();
      mw(req, res, vi.fn());
      expect(events[0].correlationId).not.toBe(longId);
      expect(events[0].correlationId).toMatch(/^probe-/);
    });

    it('rejects correlation ID with invalid characters', () => {
      const events: any[] = [];
      collector.onEvent((e) => events.push(e));
      const mw = createProbeMiddleware({ config: makeSdkConfig(), collector });
      const req = mockReq({ 'x-correlation-id': 'id with spaces & symbols!' });
      const res = mockRes();
      mw(req, res, vi.fn());
      expect(events[0].correlationId).toMatch(/^probe-/);
    });

    it('accepts correlation IDs with dots and hyphens', () => {
      const events: any[] = [];
      collector.onEvent((e) => events.push(e));
      const mw = createProbeMiddleware({ config: makeSdkConfig(), collector });
      const req = mockReq({ 'x-correlation-id': 'trace-123.span-456' });
      const res = mockRes();
      mw(req, res, vi.fn());
      expect(events[0].correlationId).toBe('trace-123.span-456');
    });
  });

  // ── Response headers ──

  describe('response headers', () => {
    it('propagates correlation ID in response header', () => {
      const mw = createProbeMiddleware({ config: makeSdkConfig(), collector });
      const req = mockReq({ 'x-correlation-id': 'abc-123' });
      const res = mockRes();
      mw(req, res, vi.fn());
      expect(res._headers['x-correlation-id']).toBe('abc-123');
    });

    it('sets x-probe-request-id response header', () => {
      const mw = createProbeMiddleware({ config: makeSdkConfig(), collector });
      const req = mockReq();
      const res = mockRes();
      mw(req, res, vi.fn());
      expect(res._headers['x-probe-request-id']).toMatch(/^req-[a-f0-9]+$/);
    });
  });

  // ── Context propagation ──

  describe('context propagation', () => {
    it('attaches probeContext to request object', () => {
      const mw = createProbeMiddleware({ config: makeSdkConfig(), collector });
      const req = mockReq({ 'x-correlation-id': 'ctx-test' });
      const res = mockRes();
      mw(req, res, vi.fn());
      const ctx = getProbeContext(req);
      expect(ctx).toBeDefined();
      expect(ctx!.correlationId).toBe('ctx-test');
      expect(ctx!.requestId).toMatch(/^req-/);
    });

    it('provides context via AsyncLocalStorage in next() chain', async () => {
      const mw = createProbeMiddleware({ config: makeSdkConfig(), collector, sessionId: 'sess-42' });
      const req = mockReq({ 'x-correlation-id': 'async-test' });
      const res = mockRes();

      let capturedContext: any;
      mw(req, res, () => {
        capturedContext = getCurrentContext();
      });

      expect(capturedContext).toBeDefined();
      expect(capturedContext.correlationId).toBe('async-test');
      expect(capturedContext.requestId).toMatch(/^req-/);
    });
  });

  // ── Header redaction ──

  describe('header redaction in events', () => {
    it('redacts Authorization header in request-start event', () => {
      const events: any[] = [];
      collector.onEvent((e) => events.push(e));
      const mw = createProbeMiddleware({
        config: makeSdkConfig({ sensitiveHeaders: ['authorization'] }),
        collector,
      });
      const req = mockReq({ authorization: 'Bearer secret-token-123' });
      const res = mockRes();
      mw(req, res, vi.fn());
      expect(events[0].headers.authorization).toBe('[REDACTED]');
    });

    it('does not redact non-sensitive headers', () => {
      const events: any[] = [];
      collector.onEvent((e) => events.push(e));
      const mw = createProbeMiddleware({ config: makeSdkConfig(), collector });
      const req = mockReq({ 'content-type': 'application/json', 'x-custom': 'value' });
      const res = mockRes();
      mw(req, res, vi.fn());
      expect(events[0].headers['content-type']).toBe('application/json');
      expect(events[0].headers['x-custom']).toBe('value');
    });
  });

  // ── Default collector ──

  describe('default collector', () => {
    it('getDefaultCollector returns singleton', () => {
      const a = getDefaultCollector();
      const b = getDefaultCollector();
      expect(a).toBe(b);
    });
  });
});
