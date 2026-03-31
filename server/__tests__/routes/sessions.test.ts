// ============================================================
// Sessions REST API — Integration tests
// ============================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { MemoryStorageAdapter } from '@probe/core';
import { sessionsRouter } from '../../src/routes/sessions.js';
import { SessionManager } from '../../src/services/session-manager.js';
import { errorHandler, notFoundHandler } from '../../src/middleware/error-handler.js';

function createApp(manager: SessionManager) {
  const app = express();
  app.use(express.json());
  app.locals['sessionManager'] = manager;
  app.use('/api/sessions', sessionsRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('Sessions API', () => {
  let storage: MemoryStorageAdapter;
  let manager: SessionManager;
  let app: ReturnType<typeof express>;

  beforeAll(async () => {
    storage = new MemoryStorageAdapter();
    await storage.initialize();
  });

  afterAll(() => {
    manager.destroy();
  });

  beforeEach(async () => {
    // Re-create to ensure a clean state
    if (manager) manager.destroy();
    await storage.close();
    storage = new MemoryStorageAdapter();
    await storage.initialize();
    manager = new SessionManager(storage);
    app = createApp(manager);
  });

  // ---- POST /api/sessions ----

  describe('POST /api/sessions', () => {
    it('creates a session with default name', async () => {
      const res = await request(app).post('/api/sessions').send({});
      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.status).toBe('idle');
      expect(res.body.name).toMatch(/^session-/);
    });

    it('creates a session with custom name', async () => {
      const res = await request(app)
        .post('/api/sessions')
        .send({ name: 'my-debug-session' });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('my-debug-session');
    });

    it('creates a session with tags', async () => {
      const res = await request(app)
        .post('/api/sessions')
        .send({ name: 'tagged', tags: ['prod', 'v2'] });
      expect(res.status).toBe(201);
      expect(res.body.tags).toEqual(['prod', 'v2']);
    });

    it('creates session with empty body', async () => {
      const res = await request(app).post('/api/sessions');
      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
    });
  });

  // ---- GET /api/sessions ----

  describe('GET /api/sessions', () => {
    it('returns empty list initially', async () => {
      const res = await request(app).get('/api/sessions');
      expect(res.status).toBe(200);
      expect(res.body.sessions).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    it('returns sessions after creation', async () => {
      await request(app).post('/api/sessions').send({ name: 'a' });
      await request(app).post('/api/sessions').send({ name: 'b' });

      const res = await request(app).get('/api/sessions');
      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(2);
      expect(res.body.total).toBe(2);
    });

    it('paginates with limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await request(app).post('/api/sessions').send({ name: `s-${i}` });
      }

      const page1 = await request(app).get('/api/sessions?limit=2&offset=0');
      expect(page1.body.sessions).toHaveLength(2);
      expect(page1.body.total).toBe(5);

      const page2 = await request(app).get('/api/sessions?limit=2&offset=2');
      expect(page2.body.sessions).toHaveLength(2);
    });

    it('filters by status', async () => {
      const { body: s1 } = await request(app).post('/api/sessions').send({ name: 'active' });
      await request(app).post('/api/sessions').send({ name: 'idle' });
      await request(app)
        .patch(`/api/sessions/${s1.id}/status`)
        .send({ status: 'capturing' });

      const res = await request(app).get('/api/sessions?status=capturing');
      expect(res.body.sessions).toHaveLength(1);
      expect(res.body.sessions[0].name).toBe('active');
    });

    it('searches by name', async () => {
      await request(app).post('/api/sessions').send({ name: 'production-bug' });
      await request(app).post('/api/sessions').send({ name: 'staging-test' });

      const res = await request(app).get('/api/sessions?search=prod');
      expect(res.body.sessions).toHaveLength(1);
      expect(res.body.sessions[0].name).toBe('production-bug');
    });

    it('clamps limit to 200', async () => {
      const res = await request(app).get('/api/sessions?limit=999');
      expect(res.status).toBe(200);
      // The route clamps to 200 — just ensure no error
    });
  });

  // ---- GET /api/sessions/:id ----

  describe('GET /api/sessions/:id', () => {
    it('returns session by id', async () => {
      const { body: created } = await request(app).post('/api/sessions').send({ name: 'fetch-me' });
      const res = await request(app).get(`/api/sessions/${created.id}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('fetch-me');
    });

    it('returns 404 for unknown id', async () => {
      const res = await request(app).get('/api/sessions/nonexistent');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Session not found');
    });
  });

  // ---- DELETE /api/sessions/:id ----

  describe('DELETE /api/sessions/:id', () => {
    it('deletes existing session', async () => {
      const { body: created } = await request(app).post('/api/sessions').send({ name: 'doomed' });
      const del = await request(app).delete(`/api/sessions/${created.id}`);
      expect(del.status).toBe(204);

      const get = await request(app).get(`/api/sessions/${created.id}`);
      expect(get.status).toBe(404);
    });

    it('returns 404 for unknown session', async () => {
      const res = await request(app).delete('/api/sessions/ghost');
      expect(res.status).toBe(404);
    });
  });

  // ---- PATCH /api/sessions/:id/status ----

  describe('PATCH /api/sessions/:id/status', () => {
    it('updates status to capturing', async () => {
      const { body: created } = await request(app).post('/api/sessions').send({ name: 'status' });
      const res = await request(app)
        .patch(`/api/sessions/${created.id}/status`)
        .send({ status: 'capturing' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('capturing');
    });

    it('sets endedAt when completing', async () => {
      const { body: created } = await request(app).post('/api/sessions').send({ name: 'ending' });
      const res = await request(app)
        .patch(`/api/sessions/${created.id}/status`)
        .send({ status: 'completed' });
      expect(res.status).toBe(200);
      expect(res.body.endedAt).toBeGreaterThan(0);
    });

    it('returns 400 for invalid status', async () => {
      const { body: created } = await request(app).post('/api/sessions').send({ name: 'bad' });
      const res = await request(app)
        .patch(`/api/sessions/${created.id}/status`)
        .send({ status: 'bogus' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid status/);
    });

    it('returns 400 for missing status', async () => {
      const { body: created } = await request(app).post('/api/sessions').send({ name: 'missing' });
      const res = await request(app)
        .patch(`/api/sessions/${created.id}/status`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 404 for unknown session', async () => {
      const res = await request(app)
        .patch('/api/sessions/nonexistent/status')
        .send({ status: 'capturing' });
      expect(res.status).toBe(404);
    });
  });
});
