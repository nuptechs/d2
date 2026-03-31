// ============================================================
// R15 Integration: WebSocket Realtime Event Streaming
// Tests the WS subscribe → event ingest → client receive flow
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import request from 'supertest';
import {
  createTestServer,
  destroyServer,
  createSession,
  ingestEvents,
  makeEvents,
  makeEvent,
  waitFor,
  type TestServerContext,
} from './helpers.js';

function connectWs(port: number, path = '/'): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function collectMessages(ws: WebSocket, count: number, timeoutMs = 5000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    const timer = setTimeout(() => {
      ws.removeAllListeners('message');
      resolve(messages); // Return what we have instead of rejecting
    }, timeoutMs);

    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.removeAllListeners('message');
        resolve(messages);
      }
    });
  });
}

function sendAndWaitForResponse(ws: WebSocket, msg: object, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS response timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
    ws.send(JSON.stringify(msg));
  });
}

describe('Integration: WebSocket Realtime Event Streaming', () => {
  let ctx: TestServerContext;

  beforeEach(async () => {
    ctx = await createTestServer();
  });

  afterEach(async () => {
    await destroyServer(ctx);
  });

  // ================================================================
  // Subscribe → Ingest → Receive flow
  // ================================================================

  describe('subscribe and receive events', () => {
    it('receives events after subscribing to a session', async () => {
      const session = await createSession(ctx.app, 'ws-test');
      const ws = await connectWs(ctx.port);

      try {
        // Subscribe
        const subMsg = await sendAndWaitForResponse(ws, {
          type: 'subscribe',
          sessionId: session.id,
        });
        expect(subMsg.type).toBe('subscribed');
        expect(subMsg.sessionId).toBe(session.id);

        // Prepare to collect messages before ingesting
        const collect = collectMessages(ws, 3, 5000);

        // Ingest 3 events via HTTP
        await ingestEvents(ctx.app, session.id, makeEvents(session.id, 3));

        // Should receive 3 event messages
        const received = await collect;
        expect(received.length).toBe(3);
        for (const msg of received) {
          expect(msg.type).toBe('event');
          expect(msg.sessionId).toBe(session.id);
          expect(msg.event).toBeTruthy();
          expect(msg.event.sessionId).toBe(session.id);
        }
      } finally {
        ws.close();
      }
    });

    it('does NOT receive events from unsubscribed sessions', async () => {
      const sessionA = await createSession(ctx.app, 'subscribed');
      const sessionB = await createSession(ctx.app, 'not-subscribed');
      const ws = await connectWs(ctx.port);

      try {
        // Subscribe only to A
        await sendAndWaitForResponse(ws, { type: 'subscribe', sessionId: sessionA.id });

        // Collect with a short timeout
        const collect = collectMessages(ws, 10, 1000);

        // Ingest to both sessions
        await ingestEvents(ctx.app, sessionA.id, makeEvents(sessionA.id, 2));
        await ingestEvents(ctx.app, sessionB.id, makeEvents(sessionB.id, 5));

        const received = await collect;
        // Should only receive events from session A
        for (const msg of received) {
          expect(msg.sessionId).toBe(sessionA.id);
        }
        expect(received.length).toBe(2);
      } finally {
        ws.close();
      }
    });

    it('unsubscribe stops event delivery', async () => {
      const session = await createSession(ctx.app, 'unsub-test');
      const ws = await connectWs(ctx.port);

      try {
        // Subscribe
        await sendAndWaitForResponse(ws, { type: 'subscribe', sessionId: session.id });

        // Unsubscribe
        const unsubMsg = await sendAndWaitForResponse(ws, { type: 'unsubscribe', sessionId: session.id });
        expect(unsubMsg.type).toBe('unsubscribed');

        // Ingest after unsubscribe
        const collect = collectMessages(ws, 5, 1000);
        await ingestEvents(ctx.app, session.id, makeEvents(session.id, 5));

        const received = await collect;
        expect(received.length).toBe(0);
      } finally {
        ws.close();
      }
    });
  });

  // ================================================================
  // Multi-subscriber isolation
  // ================================================================

  describe('multi-subscriber isolation', () => {
    it('each client receives only events from its subscribed sessions', async () => {
      const sessionA = await createSession(ctx.app, 'A');
      const sessionB = await createSession(ctx.app, 'B');

      const ws1 = await connectWs(ctx.port);
      const ws2 = await connectWs(ctx.port);

      try {
        // ws1 subscribes to A, ws2 subscribes to B
        await sendAndWaitForResponse(ws1, { type: 'subscribe', sessionId: sessionA.id });
        await sendAndWaitForResponse(ws2, { type: 'subscribe', sessionId: sessionB.id });

        const collect1 = collectMessages(ws1, 3, 3000);
        const collect2 = collectMessages(ws2, 3, 3000);

        // Ingest to both
        await ingestEvents(ctx.app, sessionA.id, makeEvents(sessionA.id, 3));
        await ingestEvents(ctx.app, sessionB.id, makeEvents(sessionB.id, 3));

        const [msgs1, msgs2] = await Promise.all([collect1, collect2]);

        // ws1 only sees A events
        expect(msgs1.length).toBe(3);
        for (const msg of msgs1) expect(msg.sessionId).toBe(sessionA.id);

        // ws2 only sees B events
        expect(msgs2.length).toBe(3);
        for (const msg of msgs2) expect(msg.sessionId).toBe(sessionB.id);
      } finally {
        ws1.close();
        ws2.close();
      }
    });

    it('multiple clients subscribing to same session all receive events', async () => {
      const session = await createSession(ctx.app, 'shared');
      const clients = await Promise.all(
        Array.from({ length: 3 }, () => connectWs(ctx.port)),
      );

      try {
        // All subscribe
        for (const ws of clients) {
          await sendAndWaitForResponse(ws, { type: 'subscribe', sessionId: session.id });
        }

        // Prepare collection
        const collectors = clients.map((ws) => collectMessages(ws, 5, 3000));

        // Ingest events
        await ingestEvents(ctx.app, session.id, makeEvents(session.id, 5));

        const allMsgs = await Promise.all(collectors);
        for (const msgs of allMsgs) {
          expect(msgs.length).toBe(5);
          for (const msg of msgs) {
            expect(msg.type).toBe('event');
            expect(msg.sessionId).toBe(session.id);
          }
        }
      } finally {
        for (const ws of clients) ws.close();
      }
    });
  });

  // ================================================================
  // Error handling and protocol validation
  // ================================================================

  describe('protocol validation', () => {
    it('rejects invalid JSON', async () => {
      const ws = await connectWs(ctx.port);

      try {
        const response = new Promise<any>((resolve) => {
          ws.once('message', (data) => resolve(JSON.parse(data.toString())));
        });

        ws.send('not-json{{');
        const msg = await response;
        expect(msg.type).toBe('error');
        expect(msg.message).toContain('Invalid JSON');
      } finally {
        ws.close();
      }
    });

    it('rejects message without type', async () => {
      const ws = await connectWs(ctx.port);

      try {
        const msg = await sendAndWaitForResponse(ws, { sessionId: 'test' });
        expect(msg.type).toBe('error');
      } finally {
        ws.close();
      }
    });

    it('rejects message without sessionId', async () => {
      const ws = await connectWs(ctx.port);

      try {
        const msg = await sendAndWaitForResponse(ws, { type: 'subscribe' });
        expect(msg.type).toBe('error');
      } finally {
        ws.close();
      }
    });

    it('rejects unknown message type', async () => {
      const ws = await connectWs(ctx.port);

      try {
        const msg = await sendAndWaitForResponse(ws, { type: 'foo', sessionId: 'x' });
        expect(msg.type).toBe('error');
        expect(msg.message).toContain('Unknown');
      } finally {
        ws.close();
      }
    });

    it('rejects session ID with invalid characters', async () => {
      const ws = await connectWs(ctx.port);

      try {
        const msg = await sendAndWaitForResponse(ws, {
          type: 'subscribe',
          sessionId: '../../../etc/passwd',
        });
        expect(msg.type).toBe('error');
        expect(msg.message).toContain('Invalid sessionId');
      } finally {
        ws.close();
      }
    });

    it('caps subscriptions per client at 50', async () => {
      const ws = await connectWs(ctx.port);

      try {
        // Subscribe to 50 sessions — pace to avoid rate limiting (20msg/s)
        for (let i = 0; i < 50; i++) {
          // Pause every 15 messages to stay under the 20/sec rate limit
          if (i > 0 && i % 15 === 0) {
            await new Promise((r) => setTimeout(r, 1100));
          }
          const msg = await sendAndWaitForResponse(ws, {
            type: 'subscribe',
            sessionId: `session-${i}`,
          });
          expect(msg.type).toBe('subscribed');
        }

        // Wait for rate limit window to reset
        await new Promise((r) => setTimeout(r, 1100));

        // 51st should fail due to subscription cap (not rate limit)
        const overflow = await sendAndWaitForResponse(ws, {
          type: 'subscribe',
          sessionId: 'session-overflow',
        });
        expect(overflow.type).toBe('error');
        expect(overflow.message).toContain('Max');
      } finally {
        ws.close();
      }
    });
  });

  // ================================================================
  // Connection lifecycle
  // ================================================================

  describe('connection lifecycle', () => {
    it('client disconnect cleans up subscriptions — no errors on next ingest', async () => {
      const session = await createSession(ctx.app, 'disconnect-test');
      const ws = await connectWs(ctx.port);

      // Subscribe and then close
      await sendAndWaitForResponse(ws, { type: 'subscribe', sessionId: session.id });
      ws.close();
      await new Promise((r) => setTimeout(r, 100));

      // Ingest should not throw or fail
      const res = await request(ctx.app)
        .post(`/api/sessions/${session.id}/events`)
        .send({ events: makeEvents(session.id, 5) });
      expect(res.status).toBe(201);
    });

    it('multiple connections from same origin work independently', async () => {
      const session = await createSession(ctx.app, 'multi-conn');
      const ws1 = await connectWs(ctx.port);
      const ws2 = await connectWs(ctx.port);

      try {
        await sendAndWaitForResponse(ws1, { type: 'subscribe', sessionId: session.id });
        await sendAndWaitForResponse(ws2, { type: 'subscribe', sessionId: session.id });

        // Close ws1
        ws1.close();
        await new Promise((r) => setTimeout(r, 100));

        // ws2 should still receive events
        const collect = collectMessages(ws2, 3, 3000);
        await ingestEvents(ctx.app, session.id, makeEvents(session.id, 3));

        const msgs = await collect;
        expect(msgs.length).toBe(3);
      } finally {
        ws1.close();
        ws2.close();
      }
    });
  });
});
