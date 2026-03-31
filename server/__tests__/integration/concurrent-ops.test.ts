// ============================================================
// R15 Integration: Concurrent Operations & Race Conditions
// Tests parallel access patterns that expose real-world bugs
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import {
  createTestContext,
  destroyContext,
  createSession,
  ingestEvents,
  makeEvent,
  makeEvents,
  type TestContext,
} from './helpers.js';

describe('Integration: Concurrent Operations & Race Conditions', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(() => {
    destroyContext(ctx);
  });

  // ================================================================
  // Parallel event ingestion to same session
  // ================================================================

  describe('parallel event ingestion — same session', () => {
    it('no events lost when 10 batches ingest concurrently', async () => {
      const session = await createSession(ctx.app);
      const batchSize = 50;
      const batchCount = 10;
      const totalExpected = batchSize * batchCount;

      // Fire 10 parallel ingest requests
      const promises = Array.from({ length: batchCount }, (_, i) =>
        request(ctx.app)
          .post(`/api/sessions/${session.id}/events`)
          .send({ events: makeEvents(session.id, batchSize, { source: 'browser' as any }) }),
      );
      const results = await Promise.all(promises);

      // All succeed
      for (const res of results) {
        expect(res.status).toBe(201);
        expect(res.body.ingested).toBe(batchSize);
      }

      // Total count matches
      const eventsRes = await request(ctx.app)
        .get(`/api/sessions/${session.id}/events`)
        .query({ limit: 10000 });
      expect(eventsRes.body.total).toBe(totalExpected);
    });

    it('event IDs remain unique across concurrent batches', async () => {
      const session = await createSession(ctx.app);

      const promises = Array.from({ length: 5 }, () =>
        request(ctx.app)
          .post(`/api/sessions/${session.id}/events`)
          .send({ events: makeEvents(session.id, 20) }),
      );
      await Promise.all(promises);

      const eventsRes = await request(ctx.app)
        .get(`/api/sessions/${session.id}/events`)
        .query({ limit: 200 });

      const ids = eventsRes.body.events.map((e: any) => e.id);
      expect(new Set(ids).size).toBe(ids.length); // No duplicates
    });
  });

  // ================================================================
  // Parallel session creation
  // ================================================================

  describe('parallel session creation', () => {
    it('creates 20 sessions concurrently with unique IDs', async () => {
      const promises = Array.from({ length: 20 }, (_, i) =>
        request(ctx.app)
          .post('/api/sessions')
          .send({ name: `concurrent-${i}` }),
      );
      const results = await Promise.all(promises);

      // All succeed
      for (const res of results) {
        expect(res.status).toBe(201);
      }

      // All IDs unique
      const ids = results.map((r) => r.body.id);
      expect(new Set(ids).size).toBe(20);

      // Total in list
      const listRes = await request(ctx.app)
        .get('/api/sessions')
        .query({ limit: 50 });
      expect(listRes.body.total).toBe(20);
    });
  });

  // ================================================================
  // Interleaved reads and writes
  // ================================================================

  describe('interleaved read/write operations', () => {
    it('reads always see consistent snapshot — no partial batches', async () => {
      const session = await createSession(ctx.app);
      const results: number[] = [];

      // Alternate writes and reads rapidly
      for (let i = 0; i < 10; i++) {
        await ingestEvents(ctx.app, session.id, makeEvents(session.id, 5));

        const res = await request(ctx.app)
          .get(`/api/sessions/${session.id}/events`)
          .query({ limit: 10000 });

        results.push(res.body.total);
      }

      // Each read should show monotonically increasing counts (5 per iteration)
      for (let i = 1; i < results.length; i++) {
        expect(results[i]).toBeGreaterThanOrEqual(results[i - 1]);
      }
      expect(results[results.length - 1]).toBe(50);
    });

    it('timeline is consistent with events count at any point', async () => {
      const session = await createSession(ctx.app);

      // Ingest in batches and check consistency
      for (let batch = 1; batch <= 5; batch++) {
        await ingestEvents(ctx.app, session.id, makeEvents(session.id, 10));

        const [eventsRes, timelineRes] = await Promise.all([
          request(ctx.app).get(`/api/sessions/${session.id}/events`).query({ limit: 10000 }),
          request(ctx.app).get(`/api/sessions/${session.id}/timeline`),
        ]);

        // Timeline event count must equal stored event count
        expect(timelineRes.body.stats.totalEvents).toBe(eventsRes.body.total);
      }
    });
  });

  // ================================================================
  // Delete during operations
  // ================================================================

  describe('delete during operations', () => {
    it('delete while ingesting returns 404 for subsequent ingest', async () => {
      const session = await createSession(ctx.app);
      await ingestEvents(ctx.app, session.id, makeEvents(session.id, 10));

      // Delete the session
      const delRes = await request(ctx.app).delete(`/api/sessions/${session.id}`);
      expect(delRes.status).toBe(204);

      // Ingest to deleted session fails
      const ingestRes = await request(ctx.app)
        .post(`/api/sessions/${session.id}/events`)
        .send({ events: makeEvents(session.id, 5) });
      expect(ingestRes.status).toBe(404);
    });

    it('double delete returns 404 on second call', async () => {
      const session = await createSession(ctx.app);
      const res1 = await request(ctx.app).delete(`/api/sessions/${session.id}`);
      expect(res1.status).toBe(204);

      const res2 = await request(ctx.app).delete(`/api/sessions/${session.id}`);
      expect(res2.status).toBe(404);
    });
  });

  // ================================================================
  // Multi-session isolation — cross-contamination prevention
  // ================================================================

  describe('multi-session isolation', () => {
    it('events from session A never appear in session B queries', async () => {
      const sessionA = await createSession(ctx.app, 'session-A');
      const sessionB = await createSession(ctx.app, 'session-B');

      const eventsA = makeEvents(sessionA.id, 20, { source: 'browser' as any });
      const eventsB = makeEvents(sessionB.id, 15, { source: 'network' as any });

      await Promise.all([
        ingestEvents(ctx.app, sessionA.id, eventsA),
        ingestEvents(ctx.app, sessionB.id, eventsB),
      ]);

      const resA = await request(ctx.app)
        .get(`/api/sessions/${sessionA.id}/events`)
        .query({ limit: 100 });
      const resB = await request(ctx.app)
        .get(`/api/sessions/${sessionB.id}/events`)
        .query({ limit: 100 });

      // Correct counts
      expect(resA.body.total).toBe(20);
      expect(resB.body.total).toBe(15);

      // No cross-contamination — session IDs match
      for (const evt of resA.body.events) {
        expect(evt.sessionId).toBe(sessionA.id);
      }
      for (const evt of resB.body.events) {
        expect(evt.sessionId).toBe(sessionB.id);
      }
    });

    it('deleting session A does not affect session B', async () => {
      const sessionA = await createSession(ctx.app, 'A');
      const sessionB = await createSession(ctx.app, 'B');

      await ingestEvents(ctx.app, sessionA.id, makeEvents(sessionA.id, 10));
      await ingestEvents(ctx.app, sessionB.id, makeEvents(sessionB.id, 10));

      // Delete A
      await request(ctx.app).delete(`/api/sessions/${sessionA.id}`);

      // B still intact
      const resB = await request(ctx.app)
        .get(`/api/sessions/${sessionB.id}/events`)
        .query({ limit: 100 });
      expect(resB.body.total).toBe(10);

      const sessionBDetail = await request(ctx.app).get(`/api/sessions/${sessionB.id}`);
      expect(sessionBDetail.status).toBe(200);
    });

    it('timelines are independent across sessions', async () => {
      const s1 = await createSession(ctx.app, 's1');
      const s2 = await createSession(ctx.app, 's2');

      await ingestEvents(ctx.app, s1.id, [
        makeEvent(s1.id, { timestamp: 100 }),
        makeEvent(s1.id, { timestamp: 200 }),
      ]);
      await ingestEvents(ctx.app, s2.id, [
        makeEvent(s2.id, { timestamp: 5000 }),
        makeEvent(s2.id, { timestamp: 6000 }),
        makeEvent(s2.id, { timestamp: 7000 }),
      ]);

      const t1 = await request(ctx.app).get(`/api/sessions/${s1.id}/timeline`);
      const t2 = await request(ctx.app).get(`/api/sessions/${s2.id}/timeline`);

      expect(t1.body.stats.totalEvents).toBe(2);
      expect(t2.body.stats.totalEvents).toBe(3);
      expect(t1.body.startTime).toBe(100);
      expect(t2.body.startTime).toBe(5000);
    });
  });

  // ================================================================
  // High-volume stress
  // ================================================================

  describe('high-volume stress', () => {
    it('handles 1000 events in a single batch without data loss', async () => {
      const session = await createSession(ctx.app);
      const events = makeEvents(session.id, 1000);
      const res = await request(ctx.app)
        .post(`/api/sessions/${session.id}/events`)
        .send({ events });
      expect(res.status).toBe(201);
      expect(res.body.ingested).toBe(1000);

      const countRes = await request(ctx.app)
        .get(`/api/sessions/${session.id}/events`)
        .query({ limit: 1 });
      expect(countRes.body.total).toBe(1000);
    });

    it('50 sessions with 100 events each — no cross-talk', async () => {
      const sessionCount = 50;
      const eventsPerSession = 100;

      // Create all sessions
      const sessions = await Promise.all(
        Array.from({ length: sessionCount }, (_, i) =>
          createSession(ctx.app, `stress-${i}`),
        ),
      );

      // Ingest events in parallel
      await Promise.all(
        sessions.map((s) =>
          ingestEvents(ctx.app, s.id, makeEvents(s.id, eventsPerSession)),
        ),
      );

      // Verify counts for each session
      const counts = await Promise.all(
        sessions.map((s) =>
          request(ctx.app)
            .get(`/api/sessions/${s.id}/events`)
            .query({ limit: 1 })
            .then((r) => r.body.total),
        ),
      );

      for (const count of counts) {
        expect(count).toBe(eventsPerSession);
      }
    });
  });
});
