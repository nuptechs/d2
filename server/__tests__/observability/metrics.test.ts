// ============================================================
// R16 Metrics Tests — Validate instrumentation correctness
// ============================================================

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import {
  createTestContext,
  createTestServer,
  destroyContext,
  destroyServer,
  makeEvents,
  type TestContext,
  type TestServerContext,
} from '../integration/helpers.js';
import { WebSocket } from 'ws';
import { requestLogger } from '../../src/middleware/request-logger.js';
import { instrumentStorage } from '../../src/lib/instrumented-storage.js';
import { MemoryStorageAdapter } from '@probe/core';
import { SessionManager } from '../../src/services/session-manager.js';
import express from 'express';
import { sessionsRouter } from '../../src/routes/sessions.js';
import { eventsRouter } from '../../src/routes/events.js';
import { reportsRouter } from '../../src/routes/reports.js';
import { errorHandler, notFoundHandler } from '../../src/middleware/error-handler.js';
import {
  registry,
  resetMetrics,
  httpRequestsTotal,
  httpRequestDuration,
  sessionsCreatedTotal,
  sessionsDeletedTotal,
  sessionStatusChanges,
  eventsIngestedTotal,
  eventBatchSize,
  eventIngestDuration,
  correlatorsCached,
  storageOperationsTotal,
  wsConnectionsTotal,
  wsConnectionsActive,
  wsSubscriptionsActive,
  wsMessagesReceived,
  wsMessagesSent,
  errorsTotal,
} from '../../src/lib/metrics.js';

// ---- Helper: get single metric value ----
async function getCounter(counter: { get: () => Promise<{ values: { value: number; labels: Record<string, string> }[] }> }, labels?: Record<string, string>): Promise<number> {
  const data = await counter.get();
  if (!labels) return data.values.reduce((sum, v) => sum + v.value, 0);
  return data.values
    .filter(v => Object.entries(labels).every(([k, val]) => v.labels[k] === val))
    .reduce((sum, v) => sum + v.value, 0);
}

async function getGauge(gauge: { get: () => Promise<{ values: { value: number }[] }> }): Promise<number> {
  const data = await gauge.get();
  return data.values[0]?.value ?? 0;
}

async function getHistogramCount(hist: { get: () => Promise<{ values: { metricName: string; value: number; labels: Record<string, string> }[] }> }, labels?: Record<string, string>): Promise<number> {
  const data = await hist.get();
  return data.values
    .filter(v => v.metricName?.endsWith('_count') || v.labels?.le === undefined)
    .filter(v => {
      if (!labels) return v.metricName?.endsWith('_count');
      return v.metricName?.endsWith('_count') && Object.entries(labels).every(([k, val]) => v.labels[k] === val);
    })
    .reduce((sum, v) => sum + v.value, 0);
}

describe('Metrics Instrumentation', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    // Add requestLogger to the test app for trace context + HTTP metrics
    const { app } = ctx;
    // Re-create app with requestLogger (insert before routes)
    const newApp = express();
    newApp.use(express.json({ limit: '50mb' }));
    newApp.use(requestLogger);
    newApp.locals['sessionManager'] = ctx.manager;
    newApp.use('/api/sessions', sessionsRouter);
    newApp.use('/api/sessions', eventsRouter);
    newApp.use('/api/sessions', reportsRouter);
    newApp.use('/api/*', notFoundHandler);
    newApp.use(errorHandler);
    (ctx as any).app = newApp;
  });

  beforeEach(() => {
    resetMetrics();
  });

  afterAll(() => {
    destroyContext(ctx);
  });

  describe('HTTP request metrics', () => {
    it('increments request counter on successful request', async () => {
      await request(ctx.app).get('/api/sessions');

      const total = await getCounter(httpRequestsTotal);
      expect(total).toBeGreaterThanOrEqual(1);
    });

    it('records request duration histogram', async () => {
      await request(ctx.app).get('/api/sessions');

      const count = await getHistogramCount(httpRequestDuration);
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it('labels requests by method and status', async () => {
      await request(ctx.app).get('/api/sessions');

      const gets = await getCounter(httpRequestsTotal, { method: 'GET', status: '200' });
      expect(gets).toBeGreaterThanOrEqual(1);
    });

    it('tracks 404 responses', async () => {
      await request(ctx.app).get('/api/sessions/nonexistent');

      const notFounds = await getCounter(httpRequestsTotal, { status: '404' });
      expect(notFounds).toBeGreaterThanOrEqual(1);
    });

    it('tracks 400 responses for invalid input', async () => {
      await request(ctx.app)
        .post('/api/sessions')
        .send({ name: '!!!invalid!!!' });

      const badRequests = await getCounter(httpRequestsTotal, { status: '400' });
      expect(badRequests).toBeGreaterThanOrEqual(1);
    });

    it('normalizes route labels to avoid high cardinality', async () => {
      const session = await request(ctx.app).post('/api/sessions').send({ name: 'route-test' });
      const id = session.body.id;

      await request(ctx.app).get(`/api/sessions/${id}`);

      // Should be labeled as /api/sessions/:id, not /api/sessions/actual-id
      const data = await httpRequestsTotal.get();
      const routes = data.values.map(v => v.labels['route']).filter(Boolean);
      expect(routes.some(r => r === '/api/sessions/:id')).toBe(true);
      expect(routes.every(r => !r.includes(id))).toBe(true);
    });
  });

  describe('Session metrics', () => {
    it('increments sessions_created_total on create', async () => {
      await request(ctx.app).post('/api/sessions').send({ name: 'metric-test' });

      const created = await getCounter(sessionsCreatedTotal);
      expect(created).toBe(1);
    });

    it('increments sessions_deleted_total on delete', async () => {
      const res = await request(ctx.app).post('/api/sessions').send({ name: 'to-delete' });
      await request(ctx.app).delete(`/api/sessions/${res.body.id}`);

      const deleted = await getCounter(sessionsDeletedTotal);
      expect(deleted).toBe(1);
    });

    it('tracks status transitions', async () => {
      const res = await request(ctx.app).post('/api/sessions').send({ name: 'status-test' });
      await request(ctx.app)
        .patch(`/api/sessions/${res.body.id}/status`)
        .send({ status: 'capturing' });

      const transitions = await getCounter(sessionStatusChanges, { from_status: 'idle', to_status: 'capturing' });
      expect(transitions).toBe(1);
    });
  });

  describe('Event metrics', () => {
    let sessionId: string;

    beforeEach(async () => {
      resetMetrics();
      const res = await request(ctx.app).post('/api/sessions').send({ name: 'event-metrics' });
      sessionId = res.body.id;
    });

    it('counts ingested events by source', async () => {
      const events = makeEvents(sessionId, 5, { source: 'network' as any });
      await request(ctx.app).post(`/api/sessions/${sessionId}/events`).send({ events });

      const network = await getCounter(eventsIngestedTotal, { source: 'network' });
      expect(network).toBe(5);
    });

    it('records batch size histogram', async () => {
      const events = makeEvents(sessionId, 25);
      await request(ctx.app).post(`/api/sessions/${sessionId}/events`).send({ events });

      const count = await getHistogramCount(eventBatchSize);
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it('records ingest duration', async () => {
      const events = makeEvents(sessionId, 10);
      await request(ctx.app).post(`/api/sessions/${sessionId}/events`).send({ events });

      const count = await getHistogramCount(eventIngestDuration);
      expect(count).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Correlator metrics', () => {
    it('tracks cached correlators gauge', async () => {
      await request(ctx.app).post('/api/sessions').send({ name: 'corr-1' });
      await request(ctx.app).post('/api/sessions').send({ name: 'corr-2' });

      const cached = await getGauge(correlatorsCached);
      expect(cached).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Storage metrics', () => {
    it('tracks storage operations via instrumented wrapper', async () => {
      resetMetrics();
      // Create instrumented storage to test storage metrics
      const rawStorage = new MemoryStorageAdapter();
      await rawStorage.initialize();
      const instrumented = instrumentStorage(rawStorage, 'memory');
      const manager = new SessionManager(instrumented as any);
      const instrumentedApp = express();
      instrumentedApp.use(express.json({ limit: '50mb' }));
      instrumentedApp.locals['sessionManager'] = manager;
      instrumentedApp.use('/api/sessions', sessionsRouter);
      instrumentedApp.use('/api/sessions', eventsRouter);
      instrumentedApp.use('/api/*', notFoundHandler);
      instrumentedApp.use(errorHandler);

      await request(instrumentedApp).post('/api/sessions').send({ name: 'storage-test' });

      const ops = await getCounter(storageOperationsTotal);
      expect(ops).toBeGreaterThan(0);

      manager.destroy();
    });

    it('records success results via instrumented wrapper', async () => {
      resetMetrics();
      const rawStorage = new MemoryStorageAdapter();
      await rawStorage.initialize();
      const instrumented = instrumentStorage(rawStorage, 'memory');
      const manager = new SessionManager(instrumented as any);
      const instrumentedApp = express();
      instrumentedApp.use(express.json({ limit: '50mb' }));
      instrumentedApp.locals['sessionManager'] = manager;
      instrumentedApp.use('/api/sessions', sessionsRouter);
      instrumentedApp.use('/api/*', notFoundHandler);
      instrumentedApp.use(errorHandler);

      await request(instrumentedApp).post('/api/sessions').send({ name: 'success-test' });

      const successes = await getCounter(storageOperationsTotal, { result: 'success' });
      expect(successes).toBeGreaterThan(0);

      manager.destroy();
    });
  });

  describe('Trace context propagation', () => {
    it('returns traceparent header in responses', async () => {
      const res = await request(ctx.app).get('/api/sessions');

      expect(res.headers['traceparent']).toBeDefined();
      // Validate W3C format: version-traceId-spanId-flags
      expect(res.headers['traceparent']).toMatch(/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    });

    it('propagates incoming traceparent header', async () => {
      const incoming = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
      const res = await request(ctx.app)
        .get('/api/sessions')
        .set('traceparent', incoming);

      // Should use the same traceId from the incoming header
      const returned = res.headers['traceparent'] as string;
      expect(returned).toBeDefined();
      expect(returned.split('-')[1]).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    });

    it('generates fresh trace context when no traceparent provided', async () => {
      const res = await request(ctx.app).get('/api/sessions');

      const traceparent = res.headers['traceparent'] as string;
      expect(traceparent).toBeDefined();
      const parts = traceparent.split('-');
      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe('00'); // version
      expect(parts[1]).toHaveLength(32); // traceId
      expect(parts[2]).toHaveLength(16); // spanId
    });

    it('includes x-request-id header', async () => {
      const res = await request(ctx.app).get('/api/sessions');
      expect(res.headers['x-request-id']).toBeDefined();
    });
  });

  describe('/metrics endpoint format', () => {
    it('returns Prometheus text format', async () => {
      // Make some API calls first to populate metrics
      await request(ctx.app).get('/api/sessions');

      const metrics = await registry.metrics();
      expect(metrics).toContain('probe_http_requests_total');
      expect(metrics).toContain('probe_http_request_duration_seconds');
      expect(metrics).toContain('# HELP');
      expect(metrics).toContain('# TYPE');
    });

    it('includes Node.js default metrics', async () => {
      const metrics = await registry.metrics();
      expect(metrics).toContain('probe_process_cpu');
      expect(metrics).toContain('probe_nodejs_heap_size_total_bytes');
    });

    it('contains all custom metric families', async () => {
      const metrics = await registry.metrics();
      const expectedMetrics = [
        'probe_http_requests_total',
        'probe_http_request_duration_seconds',
        'probe_sessions_created_total',
        'probe_sessions_deleted_total',
        'probe_events_ingested_total',
        'probe_event_batch_size',
        'probe_correlator_rebuilds_total',
        'probe_correlators_cached',
        'probe_storage_operation_duration_seconds',
        'probe_storage_operations_total',
        'probe_ws_connections_active',
        'probe_ws_connections_total',
        'probe_ws_subscriptions_active',
        'probe_errors_total',
      ];
      for (const name of expectedMetrics) {
        expect(metrics).toContain(name);
      }
    });
  });

  describe('resetMetrics', () => {
    it('resets all custom metrics to zero', async () => {
      // Generate some metrics
      await request(ctx.app).post('/api/sessions').send({ name: 'reset-test' });

      const before = await getCounter(sessionsCreatedTotal);
      expect(before).toBeGreaterThan(0);

      resetMetrics();

      const after = await getCounter(sessionsCreatedTotal);
      expect(after).toBe(0);
    });
  });
});

describe('WebSocket Metrics', () => {
  let serverCtx: TestServerContext;

  beforeAll(async () => {
    serverCtx = await createTestServer();
  });

  beforeEach(() => {
    resetMetrics();
  });

  afterAll(async () => {
    await destroyServer(serverCtx);
  });

  function connectWs(): Promise<WebSocket> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${serverCtx.port}`);
      ws.on('open', () => resolve(ws));
    });
  }

  function sendAndWait(ws: WebSocket, msg: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      const handler = (data: Buffer | string) => {
        ws.off('message', handler);
        resolve(JSON.parse(data.toString()));
      };
      ws.on('message', handler);
      ws.send(JSON.stringify(msg));
    });
  }

  it('increments connection counter on connect', async () => {
    const ws = await connectWs();

    const total = await getCounter(wsConnectionsTotal);
    expect(total).toBe(1);

    const active = await getGauge(wsConnectionsActive);
    expect(active).toBe(1);

    ws.close();
    // Wait for cleanup
    await new Promise(r => setTimeout(r, 100));
  });

  it('decrements active gauge on disconnect', async () => {
    const ws = await connectWs();
    ws.close();
    await new Promise(r => setTimeout(r, 200));

    const active = await getGauge(wsConnectionsActive);
    expect(active).toBe(0);
  });

  it('tracks subscription metrics', async () => {
    const ws = await connectWs();

    await sendAndWait(ws, { type: 'subscribe', sessionId: 'ws-metric-session' });

    const subs = await getGauge(wsSubscriptionsActive);
    expect(subs).toBe(1);

    const received = await getCounter(wsMessagesReceived, { type: 'subscribe' });
    expect(received).toBe(1);

    await sendAndWait(ws, { type: 'unsubscribe', sessionId: 'ws-metric-session' });

    const subsAfter = await getGauge(wsSubscriptionsActive);
    expect(subsAfter).toBe(0);

    ws.close();
    await new Promise(r => setTimeout(r, 100));
  });

  it('tracks messages sent to subscribers', async () => {
    // Create session
    const session = await request(serverCtx.app)
      .post('/api/sessions')
      .send({ name: 'ws-sent-test' });
    const sessionId = session.body.id;

    const ws = await connectWs();
    await sendAndWait(ws, { type: 'subscribe', sessionId });

    // Ingest events — should trigger WS push
    const events = makeEvents(sessionId, 3);
    await request(serverCtx.app)
      .post(`/api/sessions/${sessionId}/events`)
      .send({ events });

    // Wait for broadcast
    await new Promise(r => setTimeout(r, 200));

    const sent = await getCounter(wsMessagesSent);
    expect(sent).toBeGreaterThanOrEqual(3);

    ws.close();
    await new Promise(r => setTimeout(r, 100));
  });

  it('cleans up subscription metrics on disconnect with active subs', async () => {
    const ws = await connectWs();
    await sendAndWait(ws, { type: 'subscribe', sessionId: 'sub-1' });
    await sendAndWait(ws, { type: 'subscribe', sessionId: 'sub-2' });
    await sendAndWait(ws, { type: 'subscribe', sessionId: 'sub-3' });

    const beforeDisconnect = await getGauge(wsSubscriptionsActive);
    expect(beforeDisconnect).toBe(3);

    ws.close();
    await new Promise(r => setTimeout(r, 200));

    const afterDisconnect = await getGauge(wsSubscriptionsActive);
    expect(afterDisconnect).toBe(0);
  });
});
