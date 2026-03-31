// ============================================================
// Reports REST API — Integration tests
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { MemoryStorageAdapter } from '@probe/core';
import type { EventSource } from '@probe/core';
import { sessionsRouter } from '../../src/routes/sessions.js';
import { eventsRouter } from '../../src/routes/events.js';
import { reportsRouter } from '../../src/routes/reports.js';
import { SessionManager } from '../../src/services/session-manager.js';
import { errorHandler, notFoundHandler } from '../../src/middleware/error-handler.js';

function createApp(manager: SessionManager) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.locals['sessionManager'] = manager;
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/sessions', eventsRouter);
  app.use('/api/sessions', reportsRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function makeEvents(sessionId: string, count: number, source: EventSource = 'browser') {
  return Array.from({ length: count }, (_, i) => ({
    id: `evt-${i}-${Math.random().toString(36).slice(2)}`,
    sessionId,
    timestamp: 1000 + i,
    source,
    type: 'click',
    correlationId: `corr-${i}`,
  }));
}

describe('Reports API', () => {
  let storage: MemoryStorageAdapter;
  let manager: SessionManager;
  let app: ReturnType<typeof express>;
  let sessionId: string;

  beforeEach(async () => {
    storage = new MemoryStorageAdapter();
    await storage.initialize();
    manager = new SessionManager(storage);
    app = createApp(manager);

    // Create a session and add events
    const res = await request(app)
      .post('/api/sessions')
      .send({ name: 'test-report-session' });
    sessionId = res.body.id;

    const events = makeEvents(sessionId, 5);
    await request(app)
      .post(`/api/sessions/${sessionId}/events`)
      .send({ events });
  });

  afterEach(() => {
    manager.destroy();
  });

  it('generates HTML report', async () => {
    const res = await request(app).get(`/api/sessions/${sessionId}/report?format=html`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text.length).toBeGreaterThan(0);
  });

  it('generates JSON report', async () => {
    const res = await request(app).get(`/api/sessions/${sessionId}/report?format=json`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('generates Markdown report', async () => {
    const res = await request(app).get(`/api/sessions/${sessionId}/report?format=markdown`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.text.length).toBeGreaterThan(0);
  });

  it('defaults to HTML format', async () => {
    const res = await request(app).get(`/api/sessions/${sessionId}/report`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('returns 400 for invalid format', async () => {
    const res = await request(app).get(`/api/sessions/${sessionId}/report?format=pdf`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid format/);
  });

  it('returns 404 for unknown session', async () => {
    const res = await request(app).get('/api/sessions/ghost/report?format=html');
    expect(res.status).toBe(404);
  });
});
