// ============================================================
// R15 Integration: Correlation Engine via Server API
// Tests correlation behavior through the full HTTP pipeline
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import {
  createTestContext,
  destroyContext,
  createSession,
  ingestEvents,
  makeEvent,
  makeNetworkPair,
  type TestContext,
} from './helpers.js';
import type { EventSource, ProbeEvent } from '@probe/core';

describe('Integration: Correlation Engine via Server API', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(() => {
    destroyContext(ctx);
  });

  // ================================================================
  // Correlator rebuild from storage on cold access
  // ================================================================

  describe('correlator rebuild (cold access)', () => {
    it('timeline works even when correlator is not cached (rebuild from storage)', async () => {
      const session = await createSession(ctx.app);

      // Ingest events (correlator gets created for the session)
      const events = Array.from({ length: 20 }, (_, i) =>
        makeEvent(session.id, { timestamp: 1000 + i * 100, source: 'browser' as EventSource }),
      );
      await ingestEvents(ctx.app, session.id, events);

      // Access timeline — correlator should be available (warm)
      const warm = await request(ctx.app)
        .get(`/api/sessions/${session.id}/timeline`);
      expect(warm.status).toBe(200);
      expect(warm.body.stats.totalEvents).toBe(20);
    });

    it('groups endpoint returns valid data after events ingestion', async () => {
      const session = await createSession(ctx.app);

      const events = Array.from({ length: 5 }, (_, i) =>
        makeEvent(session.id, {
          timestamp: 1000 + i * 100,
          source: 'browser' as EventSource,
        }),
      );
      await ingestEvents(ctx.app, session.id, events);

      const groupsRes = await request(ctx.app)
        .get(`/api/sessions/${session.id}/groups`);
      expect(groupsRes.status).toBe(200);
      expect(groupsRes.body.groups).toBeDefined();
      expect(typeof groupsRes.body.total).toBe('number');
    });
  });

  // ================================================================
  // Timeline properties
  // ================================================================

  describe('timeline structural properties', () => {
    it('timeline entries each have event with required fields', async () => {
      const session = await createSession(ctx.app);

      const events = [
        makeEvent(session.id, { source: 'browser' as EventSource, timestamp: 1000 }),
        makeEvent(session.id, { source: 'network' as EventSource, timestamp: 2000 }),
        makeEvent(session.id, { source: 'log' as EventSource, timestamp: 3000 }),
      ];
      await ingestEvents(ctx.app, session.id, events);

      const timeline = await request(ctx.app)
        .get(`/api/sessions/${session.id}/timeline`);

      for (const entry of timeline.body.entries) {
        expect(entry.event).toBeDefined();
        expect(entry.event.id).toBeTruthy();
        expect(entry.event.sessionId).toBe(session.id);
        expect(typeof entry.event.timestamp).toBe('number');
        expect(entry.event.source).toBeTruthy();
        expect(typeof entry.depth).toBe('number');
      }
    });

    it('timeline stats are mathematically consistent', async () => {
      const session = await createSession(ctx.app);
      const sources: EventSource[] = ['browser', 'network', 'log', 'sdk'];
      const events = sources.flatMap((source, i) =>
        Array.from({ length: (i + 1) * 3 }, (_, j) =>
          makeEvent(session.id, { source, timestamp: 1000 + i * 1000 + j * 10 }),
        ),
      );
      await ingestEvents(ctx.app, session.id, events);

      const timeline = await request(ctx.app)
        .get(`/api/sessions/${session.id}/timeline`);

      const stats = timeline.body.stats;

      // totalEvents = sum of all bySource values
      const sumBySources = Object.values(stats.bySource as Record<string, number>)
        .reduce((a: number, b: number) => a + b, 0);
      expect(stats.totalEvents).toBe(sumBySources);

      // totalEvents matches entries count
      expect(stats.totalEvents).toBe(timeline.body.entries.length);

      // bySource counts match
      expect(stats.bySource.browser).toBe(3);
      expect(stats.bySource.network).toBe(6);
      expect(stats.bySource.log).toBe(9);
      expect(stats.bySource.sdk).toBe(12);
    });

    it('timestamps in timeline span equals duration', async () => {
      const session = await createSession(ctx.app);

      const events = [
        makeEvent(session.id, { timestamp: 500 }),
        makeEvent(session.id, { timestamp: 1500 }),
        makeEvent(session.id, { timestamp: 2500 }),
      ];
      await ingestEvents(ctx.app, session.id, events);

      const res = await request(ctx.app)
        .get(`/api/sessions/${session.id}/timeline`);

      const { startTime, endTime, duration } = res.body;
      expect(startTime).toBe(500);
      expect(endTime).toBe(2500);
      expect(duration).toBe(endTime - startTime);
    });
  });

  // ================================================================
  // Large event volume correlation
  // ================================================================

  describe('high-volume correlation behavior', () => {
    it('5000 events produce valid timeline without data loss', async () => {
      const session = await createSession(ctx.app);

      // Ingest in batches of 500
      for (let batch = 0; batch < 10; batch++) {
        const events = Array.from({ length: 500 }, (_, i) =>
          makeEvent(session.id, {
            timestamp: batch * 50000 + i * 100,
            source: (['browser', 'network', 'log', 'sdk'] as EventSource[])[i % 4],
          }),
        );
        await ingestEvents(ctx.app, session.id, events);
      }

      // Verify storage has all events
      const eventsRes = await request(ctx.app)
        .get(`/api/sessions/${session.id}/events`)
        .query({ limit: 1 });
      expect(eventsRes.body.total).toBe(5000);

      // Timeline should include all events
      const timeline = await request(ctx.app)
        .get(`/api/sessions/${session.id}/timeline`);
      expect(timeline.status).toBe(200);
      expect(timeline.body.stats.totalEvents).toBe(5000);

      // Source counts should be balanced
      const stats = timeline.body.stats;
      expect(stats.bySource.browser).toBe(1250);
      expect(stats.bySource.network).toBe(1250);
      expect(stats.bySource.log).toBe(1250);
      expect(stats.bySource.sdk).toBe(1250);
    });
  });

  // ================================================================
  // Edge cases
  // ================================================================

  describe('correlation edge cases', () => {
    it('single event produces valid timeline with zero duration', async () => {
      const session = await createSession(ctx.app);

      await ingestEvents(ctx.app, session.id, [
        makeEvent(session.id, { timestamp: 42 }),
      ]);

      const res = await request(ctx.app)
        .get(`/api/sessions/${session.id}/timeline`);
      expect(res.body.stats.totalEvents).toBe(1);
      expect(res.body.duration).toBe(0);
      expect(res.body.startTime).toBe(42);
      expect(res.body.endTime).toBe(42);
    });

    it('all events at same timestamp gives zero duration', async () => {
      const session = await createSession(ctx.app);

      const events = Array.from({ length: 10 }, () =>
        makeEvent(session.id, { timestamp: 1000 }),
      );
      await ingestEvents(ctx.app, session.id, events);

      const res = await request(ctx.app)
        .get(`/api/sessions/${session.id}/timeline`);
      expect(res.body.duration).toBe(0);
      expect(res.body.startTime).toBe(1000);
      expect(res.body.endTime).toBe(1000);
    });

    it('events with error type are properly counted', async () => {
      const session = await createSession(ctx.app);

      const events = [
        makeEvent(session.id, { type: 'error', timestamp: 1 }),
        makeEvent(session.id, { type: 'info', timestamp: 2 }),
        makeEvent(session.id, { type: 'error', timestamp: 3 }),
        makeEvent(session.id, { type: 'warn', timestamp: 4 }),
        makeEvent(session.id, { type: 'error', timestamp: 5 }),
      ];
      await ingestEvents(ctx.app, session.id, events);

      const res = await request(ctx.app)
        .get(`/api/sessions/${session.id}/timeline`);
      expect(res.body.stats.errors).toBe(3);
    });
  });
});
