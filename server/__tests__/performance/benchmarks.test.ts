// ============================================================
// R16 Performance Benchmarks — Latency & throughput baselines
// ============================================================
// These tests establish observable performance baselines.
// They are NOT micro-benchmarks — they measure realistic API
// latency under load to catch regressions.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestContext, destroyContext, makeEvents, type TestContext } from '../integration/helpers.js';
import type { ProbeEvent } from '@probe/core';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  destroyContext(ctx);
});

describe('Performance Baselines', () => {
  describe('Session CRUD latency', () => {
    it('creates a session in < 50ms', async () => {
      const start = performance.now();
      const res = await request(ctx.app)
        .post('/api/sessions')
        .send({ name: 'perf-test' });
      const elapsed = performance.now() - start;

      expect(res.status).toBe(201);
      expect(elapsed).toBeLessThan(50);
    });

    it('lists sessions in < 20ms (empty store)', async () => {
      const start = performance.now();
      const res = await request(ctx.app).get('/api/sessions?limit=50');
      const elapsed = performance.now() - start;

      expect(res.status).toBe(200);
      expect(elapsed).toBeLessThan(20);
    });

    it('lists sessions in < 50ms with 100 sessions', async () => {
      // Seed 100 sessions
      const ids: string[] = [];
      for (let i = 0; i < 100; i++) {
        const r = await request(ctx.app)
          .post('/api/sessions')
          .send({ name: `bulk-${i}` });
        ids.push(r.body.id);
      }

      const start = performance.now();
      const res = await request(ctx.app).get('/api/sessions?limit=50');
      const elapsed = performance.now() - start;

      expect(res.status).toBe(200);
      expect(res.body.sessions.length).toBe(50);
      expect(elapsed).toBeLessThan(50);

      // Cleanup
      for (const id of ids) {
        await request(ctx.app).delete(`/api/sessions/${id}`);
      }
    });
  });

  describe('Event ingest throughput', () => {
    let sessionId: string;

    beforeAll(async () => {
      const res = await request(ctx.app)
        .post('/api/sessions')
        .send({ name: 'ingest-bench' });
      sessionId = res.body.id;
    });

    it('ingests 100 events in < 50ms', async () => {
      const events = makeEvents(sessionId, 100);
      const start = performance.now();
      const res = await request(ctx.app)
        .post(`/api/sessions/${sessionId}/events`)
        .send({ events });
      const elapsed = performance.now() - start;

      expect(res.status).toBe(201);
      expect(res.body.ingested).toBe(100);
      expect(elapsed).toBeLessThan(50);
    });

    it('ingests 1000 events in < 200ms', async () => {
      const events = makeEvents(sessionId, 1000);
      const start = performance.now();
      const res = await request(ctx.app)
        .post(`/api/sessions/${sessionId}/events`)
        .send({ events });
      const elapsed = performance.now() - start;

      expect(res.status).toBe(201);
      expect(res.body.ingested).toBe(1000);
      expect(elapsed).toBeLessThan(200);
    });

    it('sustains 10 batches of 100 events sequentially in < 500ms total', async () => {
      const start = performance.now();
      for (let batch = 0; batch < 10; batch++) {
        const events = makeEvents(sessionId, 100);
        const res = await request(ctx.app)
          .post(`/api/sessions/${sessionId}/events`)
          .send({ events });
        expect(res.status).toBe(201);
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('Query latency', () => {
    let sessionId: string;

    beforeAll(async () => {
      const res = await request(ctx.app)
        .post('/api/sessions')
        .send({ name: 'query-bench' });
      sessionId = res.body.id;

      // Seed 2000 events with mixed sources
      const sources = ['browser', 'network', 'log', 'sdk'] as const;
      const events: ProbeEvent[] = [];
      for (let i = 0; i < 2000; i++) {
        events.push({
          id: `qb-${i}`,
          sessionId,
          timestamp: 1000 + i,
          source: sources[i % 4],
          type: i % 10 === 0 ? 'error' : 'info',
        } as ProbeEvent);
      }
      // Ingest in batches of 500
      for (let i = 0; i < events.length; i += 500) {
        await request(ctx.app)
          .post(`/api/sessions/${sessionId}/events`)
          .send({ events: events.slice(i, i + 500) });
      }
    });

    it('queries 500 events in < 30ms', async () => {
      const start = performance.now();
      const res = await request(ctx.app)
        .get(`/api/sessions/${sessionId}/events?limit=500`);
      const elapsed = performance.now() - start;

      expect(res.status).toBe(200);
      expect(res.body.events.length).toBe(500);
      expect(elapsed).toBeLessThan(30);
    });

    it('filters by source in < 30ms', async () => {
      const start = performance.now();
      const res = await request(ctx.app)
        .get(`/api/sessions/${sessionId}/events?source=network&limit=500`);
      const elapsed = performance.now() - start;

      expect(res.status).toBe(200);
      expect(res.body.events.length).toBe(500);
      expect(elapsed).toBeLessThan(30);
    });

    it('builds timeline in < 100ms for 2000 events', async () => {
      const start = performance.now();
      const res = await request(ctx.app)
        .get(`/api/sessions/${sessionId}/timeline`);
      const elapsed = performance.now() - start;

      expect(res.status).toBe(200);
      expect(res.body.stats.totalEvents).toBe(2000);
      expect(elapsed).toBeLessThan(100);
    });

    it('paginates with offset in < 30ms', async () => {
      const start = performance.now();
      const res = await request(ctx.app)
        .get(`/api/sessions/${sessionId}/events?limit=100&offset=1500`);
      const elapsed = performance.now() - start;

      expect(res.status).toBe(200);
      expect(res.body.events.length).toBe(100);
      expect(elapsed).toBeLessThan(30);
    });
  });

  describe('Concurrent request handling', () => {
    it('handles 50 parallel GET requests in < 200ms', async () => {
      const session = await request(ctx.app)
        .post('/api/sessions')
        .send({ name: 'concurrent-reads' });
      const id = session.body.id;

      const start = performance.now();
      const promises = Array.from({ length: 50 }, () =>
        request(ctx.app).get(`/api/sessions/${id}`),
      );
      const results = await Promise.all(promises);
      const elapsed = performance.now() - start;

      expect(results.every(r => r.status === 200)).toBe(true);
      expect(elapsed).toBeLessThan(200);
    });

    it('handles 20 parallel ingest requests without data loss', async () => {
      const session = await request(ctx.app)
        .post('/api/sessions')
        .send({ name: 'concurrent-writes' });
      const id = session.body.id;

      const start = performance.now();
      const promises = Array.from({ length: 20 }, (_, i) => {
        const events = makeEvents(id, 10, { type: `batch-${i}` });
        return request(ctx.app)
          .post(`/api/sessions/${id}/events`)
          .send({ events });
      });
      const results = await Promise.all(promises);
      const elapsed = performance.now() - start;

      expect(results.every(r => r.status === 201)).toBe(true);

      // Verify all events persisted
      const eventsRes = await request(ctx.app)
        .get(`/api/sessions/${id}/events?limit=10000`);
      expect(eventsRes.body.total).toBe(200);
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('Throughput under mixed workload', () => {
    it('sustains 100 mixed ops (create + ingest + query) in < 2s', async () => {
      const start = performance.now();
      const ops: Promise<unknown>[] = [];

      for (let i = 0; i < 100; i++) {
        const mod = i % 3;
        if (mod === 0) {
          // Create
          ops.push(
            request(ctx.app).post('/api/sessions').send({ name: `mixed-${i}` }),
          );
        } else if (mod === 1) {
          // Ingest — create + ingest
          ops.push(
            request(ctx.app)
              .post('/api/sessions')
              .send({ name: `mixed-ingest-${i}` })
              .then(async (res) => {
                if (res.status === 201) {
                  const events = makeEvents(res.body.id, 10);
                  return request(ctx.app)
                    .post(`/api/sessions/${res.body.id}/events`)
                    .send({ events });
                }
              }),
          );
        } else {
          // List
          ops.push(request(ctx.app).get('/api/sessions?limit=10'));
        }
      }

      await Promise.all(ops);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(2000);
    });
  });
});
