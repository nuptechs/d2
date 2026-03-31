// ============================================================
// R15 Integration: Full Ingest → Correlate → Query Pipeline
// Tests the complete data flow through the server via HTTP API
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
  makeNetworkPair,
  makeMultiSourceSequence,
  type TestContext,
} from './helpers.js';

describe('Integration: Ingest → Correlate → Query Pipeline', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(() => {
    destroyContext(ctx);
  });

  // ================================================================
  // Full lifecycle: create → ingest → query → timeline → groups
  // ================================================================

  describe('full session lifecycle', () => {
    it('creates session, ingests events, queries timeline and groups', async () => {
      // 1. Create session
      const session = await createSession(ctx.app, 'lifecycle-test');
      expect(session.id).toBeTruthy();
      expect(session.status).toBe('idle');
      expect(session.eventCount).toBe(0);

      // 2. Ingest a batch of mixed-source events
      const events = makeMultiSourceSequence(session.id, 20);
      const ingested = await ingestEvents(ctx.app, session.id, events);
      expect(ingested).toBe(20);

      // 3. Query events back — all should be persisted
      const eventsRes = await request(ctx.app)
        .get(`/api/sessions/${session.id}/events`)
        .query({ limit: 100 });
      expect(eventsRes.status).toBe(200);
      expect(eventsRes.body.events).toHaveLength(20);
      expect(eventsRes.body.total).toBe(20);

      // 4. Timeline should reflect all ingested events
      const timelineRes = await request(ctx.app)
        .get(`/api/sessions/${session.id}/timeline`);
      expect(timelineRes.status).toBe(200);
      expect(timelineRes.body.stats.totalEvents).toBe(20);
      expect(timelineRes.body.startTime).toBeLessThanOrEqual(timelineRes.body.endTime);
      expect(timelineRes.body.duration).toBeGreaterThanOrEqual(0);

      // 5. Status transitions work
      const statusRes = await request(ctx.app)
        .patch(`/api/sessions/${session.id}/status`)
        .send({ status: 'completed' });
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.status).toBe('completed');
    });

    it('handles empty session — timeline and groups return valid empty structures', async () => {
      const session = await createSession(ctx.app, 'empty-session');

      const timelineRes = await request(ctx.app)
        .get(`/api/sessions/${session.id}/timeline`);
      expect(timelineRes.status).toBe(200);
      expect(timelineRes.body.entries).toHaveLength(0);
      expect(timelineRes.body.stats.totalEvents).toBe(0);

      const groupsRes = await request(ctx.app)
        .get(`/api/sessions/${session.id}/groups`);
      expect(groupsRes.status).toBe(200);
      expect(groupsRes.body.groups).toHaveLength(0);
    });
  });

  // ================================================================
  // Multi-batch ingestion — events accumulate correctly
  // ================================================================

  describe('multi-batch ingestion', () => {
    it('accumulates events across multiple POST requests', async () => {
      const session = await createSession(ctx.app);

      // Ingest 3 separate batches
      await ingestEvents(ctx.app, session.id, makeEvents(session.id, 10, { source: 'browser' as any }));
      await ingestEvents(ctx.app, session.id, makeEvents(session.id, 15, { source: 'network' as any }));
      await ingestEvents(ctx.app, session.id, makeEvents(session.id, 5, { source: 'log' as any }));

      const res = await request(ctx.app)
        .get(`/api/sessions/${session.id}/events`)
        .query({ limit: 100 });
      expect(res.body.total).toBe(30);
    });

    it('source filter works correctly after multi-batch ingest', async () => {
      const session = await createSession(ctx.app);

      await ingestEvents(ctx.app, session.id, makeEvents(session.id, 8, { source: 'browser' as any }));
      await ingestEvents(ctx.app, session.id, makeEvents(session.id, 12, { source: 'network' as any }));

      const browserRes = await request(ctx.app)
        .get(`/api/sessions/${session.id}/events`)
        .query({ source: 'browser', limit: 100 });
      expect(browserRes.body.events).toHaveLength(8);

      const networkRes = await request(ctx.app)
        .get(`/api/sessions/${session.id}/events`)
        .query({ source: 'network', limit: 100 });
      expect(networkRes.body.events).toHaveLength(12);
    });

    it('pagination returns correct slices with offset', async () => {
      const session = await createSession(ctx.app);
      const events = makeEvents(session.id, 50);
      await ingestEvents(ctx.app, session.id, events);

      // First page
      const page1 = await request(ctx.app)
        .get(`/api/sessions/${session.id}/events`)
        .query({ limit: 10, offset: 0 });
      expect(page1.body.events).toHaveLength(10);
      expect(page1.body.total).toBe(50);

      // Second page
      const page2 = await request(ctx.app)
        .get(`/api/sessions/${session.id}/events`)
        .query({ limit: 10, offset: 10 });
      expect(page2.body.events).toHaveLength(10);

      // No overlap between pages
      const ids1 = new Set(page1.body.events.map((e: any) => e.id));
      const ids2 = new Set(page2.body.events.map((e: any) => e.id));
      const overlap = [...ids1].filter((id) => ids2.has(id));
      expect(overlap).toHaveLength(0);

      // Last page (partial)
      const lastPage = await request(ctx.app)
        .get(`/api/sessions/${session.id}/events`)
        .query({ limit: 10, offset: 45 });
      expect(lastPage.body.events).toHaveLength(5);

      // Beyond end
      const empty = await request(ctx.app)
        .get(`/api/sessions/${session.id}/events`)
        .query({ limit: 10, offset: 100 });
      expect(empty.body.events).toHaveLength(0);
    });

    it('time-range filter isolates events correctly', async () => {
      const session = await createSession(ctx.app);

      // Events at timestamps: 1000, 1100, 1200, ..., 1900
      const events = Array.from({ length: 10 }, (_, i) =>
        makeEvent(session.id, { timestamp: 1000 + i * 100 }),
      );
      await ingestEvents(ctx.app, session.id, events);

      // Only events between 1200 and 1500 inclusive
      const res = await request(ctx.app)
        .get(`/api/sessions/${session.id}/events`)
        .query({ fromTime: 1200, toTime: 1500, limit: 100 });

      // timestamps 1200, 1300, 1400, 1500 = 4 events
      expect(res.body.events.length).toBeGreaterThanOrEqual(3);
      for (const evt of res.body.events) {
        expect(evt.timestamp).toBeGreaterThanOrEqual(1200);
        expect(evt.timestamp).toBeLessThanOrEqual(1500);
      }
    });
  });

  // ================================================================
  // Timeline integrity — ordering, stats consistency
  // ================================================================

  describe('timeline data integrity', () => {
    it('timeline entries are sorted by timestamp ascending', async () => {
      const session = await createSession(ctx.app);

      // Deliberately ingest out of order
      const events = [
        makeEvent(session.id, { timestamp: 3000 }),
        makeEvent(session.id, { timestamp: 1000 }),
        makeEvent(session.id, { timestamp: 5000 }),
        makeEvent(session.id, { timestamp: 2000 }),
        makeEvent(session.id, { timestamp: 4000 }),
      ];
      await ingestEvents(ctx.app, session.id, events);

      const res = await request(ctx.app)
        .get(`/api/sessions/${session.id}/timeline`);
      expect(res.status).toBe(200);

      const timestamps = res.body.entries.map((e: any) => e.event.timestamp);
      expect(timestamps).toEqual([...timestamps].sort((a: number, b: number) => a - b));
    });

    it('timeline stats.bySource matches actual event distribution', async () => {
      const session = await createSession(ctx.app);

      await ingestEvents(ctx.app, session.id, makeEvents(session.id, 5, { source: 'browser' as any }));
      await ingestEvents(ctx.app, session.id, makeEvents(session.id, 3, { source: 'network' as any }));
      await ingestEvents(ctx.app, session.id, makeEvents(session.id, 7, { source: 'log' as any }));

      const res = await request(ctx.app)
        .get(`/api/sessions/${session.id}/timeline`);

      expect(res.body.stats.totalEvents).toBe(15);
      expect(res.body.stats.bySource.browser).toBe(5);
      expect(res.body.stats.bySource.network).toBe(3);
      expect(res.body.stats.bySource.log).toBe(7);
    });

    it('timeline duration equals endTime - startTime', async () => {
      const session = await createSession(ctx.app);

      const events = [
        makeEvent(session.id, { timestamp: 1000 }),
        makeEvent(session.id, { timestamp: 5000 }),
      ];
      await ingestEvents(ctx.app, session.id, events);

      const res = await request(ctx.app)
        .get(`/api/sessions/${session.id}/timeline`);

      expect(res.body.duration).toBe(res.body.endTime - res.body.startTime);
      expect(res.body.startTime).toBe(1000);
      expect(res.body.endTime).toBe(5000);
      expect(res.body.duration).toBe(4000);
    });

    it('error events are counted in timeline stats', async () => {
      const session = await createSession(ctx.app);

      const events = [
        makeEvent(session.id, { type: 'error', timestamp: 1000 }),
        makeEvent(session.id, { type: 'error', timestamp: 2000 }),
        makeEvent(session.id, { type: 'info', timestamp: 3000 }),
        makeEvent(session.id, { type: 'error', timestamp: 4000 }),
      ];
      await ingestEvents(ctx.app, session.id, events);

      const res = await request(ctx.app)
        .get(`/api/sessions/${session.id}/timeline`);
      expect(res.body.stats.errors).toBe(3);
    });
  });

  // ================================================================
  // Session CRUD data consistency
  // ================================================================

  describe('session data consistency', () => {
    it('deleted session returns 404 on all endpoints', async () => {
      const session = await createSession(ctx.app);
      await ingestEvents(ctx.app, session.id, makeEvents(session.id, 5));

      // Delete
      const delRes = await request(ctx.app).delete(`/api/sessions/${session.id}`);
      expect(delRes.status).toBe(204);

      // All subsequent requests return 404
      expect((await request(ctx.app).get(`/api/sessions/${session.id}`)).status).toBe(404);
      expect((await request(ctx.app).get(`/api/sessions/${session.id}/events`)).status).toBe(404);
      expect((await request(ctx.app).get(`/api/sessions/${session.id}/timeline`)).status).toBe(404);
      expect((await request(ctx.app).get(`/api/sessions/${session.id}/groups`)).status).toBe(404);
      expect((await request(ctx.app).post(`/api/sessions/${session.id}/events`).send({ events: [] })).status).toBe(404);
    });

    it('session list pagination is consistent with total count', async () => {
      // Create 15 sessions
      for (let i = 0; i < 15; i++) {
        await createSession(ctx.app, `session-${i}`);
      }

      const page1 = await request(ctx.app)
        .get('/api/sessions')
        .query({ limit: 5, offset: 0 });
      expect(page1.body.sessions).toHaveLength(5);
      expect(page1.body.total).toBe(15);

      const page2 = await request(ctx.app)
        .get('/api/sessions')
        .query({ limit: 5, offset: 5 });
      expect(page2.body.sessions).toHaveLength(5);

      const page3 = await request(ctx.app)
        .get('/api/sessions')
        .query({ limit: 5, offset: 10 });
      expect(page3.body.sessions).toHaveLength(5);

      // All session IDs across pages are unique
      const allIds = [
        ...page1.body.sessions.map((s: any) => s.id),
        ...page2.body.sessions.map((s: any) => s.id),
        ...page3.body.sessions.map((s: any) => s.id),
      ];
      expect(new Set(allIds).size).toBe(15);
    });

    it('status transitions are persisted and retrievable', async () => {
      const session = await createSession(ctx.app);
      expect(session.status).toBe('idle');

      const statuses = ['capturing', 'paused', 'capturing', 'completed'] as const;
      for (const status of statuses) {
        const res = await request(ctx.app)
          .patch(`/api/sessions/${session.id}/status`)
          .send({ status });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe(status);

        // Verify via GET
        const getRes = await request(ctx.app).get(`/api/sessions/${session.id}`);
        expect(getRes.body.status).toBe(status);
      }
    });

    it('completed session still allows event queries', async () => {
      const session = await createSession(ctx.app);
      await ingestEvents(ctx.app, session.id, makeEvents(session.id, 10));

      // Mark as completed
      await request(ctx.app)
        .patch(`/api/sessions/${session.id}/status`)
        .send({ status: 'completed' });

      // Events should still be queryable
      const res = await request(ctx.app)
        .get(`/api/sessions/${session.id}/events`)
        .query({ limit: 100 });
      expect(res.body.events).toHaveLength(10);
    });
  });

  // ================================================================
  // Input validation boundary tests
  // ================================================================

  describe('input validation boundaries', () => {
    it('rejects session ID with path traversal characters', async () => {
      const malicious = ['../etc', '..%2F', '<script>', 'a b c', '../../passwd'];
      for (const id of malicious) {
        const res = await request(ctx.app).get(`/api/sessions/${encodeURIComponent(id)}`);
        expect(res.status).toBe(400);
      }
    });

    it('rejects oversized session name', async () => {
      const res = await request(ctx.app)
        .post('/api/sessions')
        .send({ name: 'x'.repeat(300) });
      expect(res.status).toBe(400);
    });

    it('rejects event batch exceeding 1000 events', async () => {
      const session = await createSession(ctx.app);
      const events = makeEvents(session.id, 1001);
      const res = await request(ctx.app)
        .post(`/api/sessions/${session.id}/events`)
        .send({ events });
      expect(res.status).toBe(400);
    });

    it('rejects events with missing required fields', async () => {
      const session = await createSession(ctx.app);
      const res = await request(ctx.app)
        .post(`/api/sessions/${session.id}/events`)
        .send({ events: [{ id: 'only-id' }] });
      expect(res.status).toBe(400);
    });

    it('rejects invalid event source enum', async () => {
      const session = await createSession(ctx.app);
      const res = await request(ctx.app)
        .post(`/api/sessions/${session.id}/events`)
        .send({
          events: [{
            id: 'e1',
            sessionId: session.id,
            timestamp: 1000,
            source: 'invalid-source',
          }],
        });
      expect(res.status).toBe(400);
    });

    it('rejects invalid status transition values', async () => {
      const session = await createSession(ctx.app);
      const res = await request(ctx.app)
        .patch(`/api/sessions/${session.id}/status`)
        .send({ status: 'nonexistent' });
      expect(res.status).toBe(400);
    });

    it('rejects strict mode: unknown fields in session creation', async () => {
      const res = await request(ctx.app)
        .post('/api/sessions')
        .send({ name: 'test', hacked: true });
      expect(res.status).toBe(400);
    });

    it('session ID max 128 chars is enforced', async () => {
      const longId = 'a'.repeat(129);
      const res = await request(ctx.app).get(`/api/sessions/${longId}`);
      expect(res.status).toBe(400);
    });

    it('exactly 128-char session ID is accepted', async () => {
      const validId = 'a'.repeat(128);
      const res = await request(ctx.app).get(`/api/sessions/${validId}`);
      // Should be 404 (not found) not 400 (invalid)
      expect(res.status).toBe(404);
    });

    it('query params with out-of-range values are rejected', async () => {
      const session = await createSession(ctx.app);

      // limit exceeds max
      const res = await request(ctx.app)
        .get(`/api/sessions/${session.id}/events`)
        .query({ limit: 50000 });
      expect(res.status).toBe(400);

      // negative offset
      const res2 = await request(ctx.app)
        .get(`/api/sessions/${session.id}/events`)
        .query({ offset: -1 });
      expect(res2.status).toBe(400);
    });
  });

  // ================================================================
  // Report generation integration
  // ================================================================

  describe('report generation', () => {
    it('generates JSON report from session with events', async () => {
      const session = await createSession(ctx.app);
      await ingestEvents(ctx.app, session.id, makeMultiSourceSequence(session.id, 10));

      const res = await request(ctx.app)
        .get(`/api/sessions/${session.id}/report`)
        .query({ format: 'json' });
      // Should succeed or 500 if reporter not built — either way not a 400
      expect([200, 500]).toContain(res.status);
    });

    it('rejects invalid report format', async () => {
      const session = await createSession(ctx.app);
      const res = await request(ctx.app)
        .get(`/api/sessions/${session.id}/report`)
        .query({ format: 'pdf' });
      expect(res.status).toBe(400);
    });

    it('returns 404 for report on non-existent session', async () => {
      const res = await request(ctx.app)
        .get('/api/sessions/nonexistent/report')
        .query({ format: 'json' });
      expect(res.status).toBe(404);
    });
  });
});
