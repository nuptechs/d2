// ============================================================
// Events REST API — Integration tests
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { MemoryStorageAdapter } from '@probe/core';
import type { EventSource } from '@probe/core';
import { sessionsRouter } from '../../src/routes/sessions.js';
import { eventsRouter } from '../../src/routes/events.js';
import { SessionManager } from '../../src/services/session-manager.js';
import { errorHandler, notFoundHandler } from '../../src/middleware/error-handler.js';

function createApp(manager: SessionManager) {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.locals['sessionManager'] = manager;
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/sessions', eventsRouter);
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
    correlationId: `corr-${i}`,
  }));
}

describe('Events API', () => {
  let storage: MemoryStorageAdapter;
  let manager: SessionManager;
  let app: ReturnType<typeof express>;
  let sessionId: string;

  beforeEach(async () => {
    storage = new MemoryStorageAdapter();
    await storage.initialize();
    manager = new SessionManager(storage);
    app = createApp(manager);

    // Pre-create a session for event tests
    const res = await request(app).post('/api/sessions').send({ name: 'event-test' });
    sessionId = res.body.id;
  });

  afterEach(() => {
    manager.destroy();
  });

  // ---- POST /api/sessions/:id/events ----

  describe('POST /api/sessions/:id/events', () => {
    it('ingests events batch', async () => {
      const events = makeEvents(sessionId, 3);
      const res = await request(app)
        .post(`/api/sessions/${sessionId}/events`)
        .send({ events });
      expect(res.status).toBe(201);
      expect(res.body.ingested).toBe(3);
    });

    it('accepts array body directly', async () => {
      const events = makeEvents(sessionId, 2);
      const res = await request(app)
        .post(`/api/sessions/${sessionId}/events`)
        .send(events);
      expect(res.status).toBe(201);
      expect(res.body.ingested).toBe(2);
    });

    it('returns 404 for unknown session', async () => {
      const events = makeEvents('ghost', 1);
      const res = await request(app)
        .post('/api/sessions/ghost/events')
        .send({ events });
      expect(res.status).toBe(404);
    });

    it('rejects batch over 1000 events', async () => {
      const events = makeEvents(sessionId, 1001);
      const res = await request(app)
        .post(`/api/sessions/${sessionId}/events`)
        .send({ events });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Batch size/);
    });

    it('validates event structure', async () => {
      const res = await request(app)
        .post(`/api/sessions/${sessionId}/events`)
        .send({ events: [{ bad: 'data' }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/id, sessionId, timestamp, and source/);
    });
  });

  // ---- GET /api/sessions/:id/events ----

  describe('GET /api/sessions/:id/events', () => {
    it('returns events with pagination', async () => {
      const events = makeEvents(sessionId, 10);
      await request(app)
        .post(`/api/sessions/${sessionId}/events`)
        .send({ events });

      const res = await request(app).get(`/api/sessions/${sessionId}/events?limit=5`);
      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(5);
      expect(res.body.total).toBe(10);
    });

    it('returns events with offset', async () => {
      const events = makeEvents(sessionId, 5);
      await request(app)
        .post(`/api/sessions/${sessionId}/events`)
        .send({ events });

      const res = await request(app).get(`/api/sessions/${sessionId}/events?limit=3&offset=3`);
      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(2);
    });

    it('returns 404 for unknown session', async () => {
      const res = await request(app).get('/api/sessions/ghost/events');
      expect(res.status).toBe(404);
    });

    it('filters by source', async () => {
      const browserEvents = makeEvents(sessionId, 3, 'browser');
      const networkEvents = makeEvents(sessionId, 2, 'network');
      await request(app)
        .post(`/api/sessions/${sessionId}/events`)
        .send({ events: [...browserEvents, ...networkEvents] });

      const res = await request(app).get(`/api/sessions/${sessionId}/events?source=network`);
      expect(res.status).toBe(200);
      expect(res.body.events.every((e: { source: string }) => e.source === 'network')).toBe(true);
    });

    it('handles invalid limit/offset gracefully', async () => {
      const res = await request(app).get(`/api/sessions/${sessionId}/events?limit=abc&offset=-1`);
      expect(res.status).toBe(200);
      // Should use defaults (limit=500, offset=0)
    });
  });

  // ---- GET /api/sessions/:id/timeline ----

  describe('GET /api/sessions/:id/timeline', () => {
    it('returns timeline for session with events', async () => {
      const events = makeEvents(sessionId, 5);
      await request(app)
        .post(`/api/sessions/${sessionId}/events`)
        .send({ events });

      const res = await request(app).get(`/api/sessions/${sessionId}/timeline`);
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(5);
      expect(res.body.startTime).toBe(1000);
      expect(res.body.endTime).toBe(1004);
      expect(res.body.duration).toBe(4);
      expect(res.body.stats.totalEvents).toBe(5);
    });

    it('returns 404 for unknown session', async () => {
      const res = await request(app).get('/api/sessions/ghost/timeline');
      expect(res.status).toBe(404);
    });
  });

  // ---- GET /api/sessions/:id/groups ----

  describe('GET /api/sessions/:id/groups', () => {
    it('returns groups for session', async () => {
      const events = makeEvents(sessionId, 3);
      await request(app)
        .post(`/api/sessions/${sessionId}/events`)
        .send({ events });

      const res = await request(app).get(`/api/sessions/${sessionId}/groups`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.groups)).toBe(true);
      expect(typeof res.body.total).toBe('number');
    });

    it('returns 404 for unknown session', async () => {
      const res = await request(app).get('/api/sessions/ghost/groups');
      expect(res.status).toBe(404);
    });
  });
});
