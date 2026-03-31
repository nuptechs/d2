// ============================================================
// R15 Integration Test Helpers — Shared app factory & builders
// ============================================================

import express from 'express';
import { createServer, type Server } from 'node:http';
import { MemoryStorageAdapter } from '@probe/core';
import type { ProbeEvent, EventSource, DebugSession } from '@probe/core';
import { sessionsRouter } from '../../src/routes/sessions.js';
import { eventsRouter } from '../../src/routes/events.js';
import { reportsRouter } from '../../src/routes/reports.js';
import { SessionManager } from '../../src/services/session-manager.js';
import { errorHandler, notFoundHandler } from '../../src/middleware/error-handler.js';
import { setupWebSocket } from '../../src/ws/realtime.js';
import { WebSocketServer } from 'ws';
import request from 'supertest';

export interface TestContext {
  app: ReturnType<typeof express>;
  storage: MemoryStorageAdapter;
  manager: SessionManager;
}

export interface TestServerContext extends TestContext {
  server: Server;
  wss: WebSocketServer;
  port: number;
  baseUrl: string;
}

/** Create Express app with all routes, no auth, no rate limiting */
export function createTestApp(manager: SessionManager): ReturnType<typeof express> {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.locals['sessionManager'] = manager;
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/sessions', eventsRouter);
  app.use('/api/sessions', reportsRouter);
  app.use('/api/*', notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** Spin up full test context: storage + manager + app */
export async function createTestContext(): Promise<TestContext> {
  const storage = new MemoryStorageAdapter();
  await storage.initialize();
  const manager = new SessionManager(storage);
  const app = createTestApp(manager);
  return { app, storage, manager };
}

/** Create HTTP server with WebSocket for WS integration tests */
export async function createTestServer(): Promise<TestServerContext> {
  const ctx = await createTestContext();
  const server = createServer(ctx.app);
  const wss = setupWebSocket(server, ctx.manager);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        ...ctx,
        server,
        wss,
        port: addr.port,
        baseUrl: `http://127.0.0.1:${addr.port}`,
      });
    });
  });
}

/** Destroy test context cleanly */
export function destroyContext(ctx: TestContext): void {
  ctx.manager.destroy();
}

/** Destroy test server cleanly */
export async function destroyServer(ctx: TestServerContext): Promise<void> {
  ctx.manager.destroy();
  for (const ws of ctx.wss.clients) ws.terminate();
  ctx.wss.close();
  await new Promise<void>((resolve, reject) => {
    ctx.server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ---- Builders ----

let _eventCounter = 0;

export function makeEvent(
  sessionId: string,
  overrides: Partial<ProbeEvent> = {},
): ProbeEvent {
  _eventCounter++;
  return {
    id: `evt-${_eventCounter}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    timestamp: Date.now() + _eventCounter,
    source: 'browser' as EventSource,
    ...overrides,
  } as ProbeEvent;
}

export function makeEvents(
  sessionId: string,
  count: number,
  overrides: Partial<ProbeEvent> = {},
): ProbeEvent[] {
  return Array.from({ length: count }, (_, i) =>
    makeEvent(sessionId, { timestamp: 1000 + i, ...overrides }),
  );
}

/** Create a network request/response event pair with shared correlationId */
export function makeNetworkPair(sessionId: string, correlationId: string, baseTime = 1000): ProbeEvent[] {
  return [
    makeEvent(sessionId, {
      source: 'network' as EventSource,
      type: 'request',
      correlationId,
      timestamp: baseTime,
      url: `https://api.example.com/data/${correlationId}`,
      method: 'GET',
    } as Partial<ProbeEvent>),
    makeEvent(sessionId, {
      source: 'network' as EventSource,
      type: 'response',
      correlationId,
      timestamp: baseTime + 50,
      url: `https://api.example.com/data/${correlationId}`,
      method: 'GET',
      statusCode: 200,
    } as Partial<ProbeEvent>),
  ];
}

/** Create a timed sequence of events from multiple sources */
export function makeMultiSourceSequence(sessionId: string, count: number): ProbeEvent[] {
  const sources: EventSource[] = ['browser', 'network', 'log', 'sdk'];
  return Array.from({ length: count }, (_, i) =>
    makeEvent(sessionId, {
      source: sources[i % sources.length],
      timestamp: 1000 + i * 100,
      type: i % 3 === 0 ? 'error' : 'info',
    }),
  );
}

/** Helper to create session via API */
export async function createSession(
  app: ReturnType<typeof express>,
  name = 'test-session',
): Promise<DebugSession> {
  const res = await request(app).post('/api/sessions').send({ name });
  if (res.status !== 201) throw new Error(`Failed to create session: ${res.text}`);
  return res.body as DebugSession;
}

/** Helper to ingest events via API */
export async function ingestEvents(
  app: ReturnType<typeof express>,
  sessionId: string,
  events: ProbeEvent[],
): Promise<number> {
  const res = await request(app)
    .post(`/api/sessions/${sessionId}/events`)
    .send({ events });
  if (res.status !== 201) throw new Error(`Failed to ingest events: ${res.text}`);
  return res.body.ingested;
}

/** Wait for a condition with timeout */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
