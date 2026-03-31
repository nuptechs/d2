// ============================================================
// WebSocket Realtime — Comprehensive tests
// Auth, subscription, malformed messages, rate limiting
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { setupWebSocket } from '../../src/ws/realtime.js';
import type { AuthConfig } from '../../src/middleware/auth.js';
import { signJwt } from '../../src/middleware/auth.js';

// ── Helpers ───────────────────────────────────────────────────

function createMockSessionManager() {
  const listeners: Array<(sessionId: string, events: any[]) => void> = [];
  return {
    onEventsIngested: vi.fn((listener: any) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }),
    _emit(sessionId: string, events: any[]) {
      for (const l of listeners) l(sessionId, events);
    },
  };
}

function startServer(authConfig?: AuthConfig): Promise<{ server: http.Server; wss: WebSocketServer; port: number; manager: ReturnType<typeof createMockSessionManager> }> {
  return new Promise((resolve) => {
    const server = http.createServer();
    const manager = createMockSessionManager();
    const wss = setupWebSocket(server, manager as any, authConfig);
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({ server, wss, port: addr.port, manager });
    });
  });
}

function connectWs(port: number, params = ''): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${params}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

// ── Tests ─────────────────────────────────────────────────────

describe('WebSocket Realtime', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let port: number;
  let manager: ReturnType<typeof createMockSessionManager>;

  afterEach(async () => {
    wss?.close();
    await new Promise<void>((r) => server?.close(() => r()));
  });

  // ── No-auth mode ──

  describe('without auth', () => {
    beforeEach(async () => {
      ({ server, wss, port, manager } = await startServer());
    });

    it('accepts connection without credentials', async () => {
      const ws = await connectWs(port);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('subscribe and receive confirmation', async () => {
      const ws = await connectWs(port);
      ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'sess-1' }));
      const msg = await waitForMessage(ws);
      expect(msg).toEqual({ type: 'subscribed', sessionId: 'sess-1' });
      ws.close();
    });

    it('unsubscribe and receive confirmation', async () => {
      const ws = await connectWs(port);
      ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'sess-1' }));
      await waitForMessage(ws);
      ws.send(JSON.stringify({ type: 'unsubscribe', sessionId: 'sess-1' }));
      const msg = await waitForMessage(ws);
      expect(msg).toEqual({ type: 'unsubscribed', sessionId: 'sess-1' });
      ws.close();
    });

    it('receives events after subscribing', async () => {
      const ws = await connectWs(port);
      ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'test-session' }));
      await waitForMessage(ws); // subscribed confirmation

      const event = { id: 'e1', type: 'log', source: 'sdk', sessionId: 'test-session', timestamp: 1 };
      manager._emit('test-session', [event]);

      const msg = await waitForMessage(ws);
      expect(msg.type).toBe('event');
      expect(msg.sessionId).toBe('test-session');
      expect(msg.event.id).toBe('e1');
      ws.close();
    });

    it('does not receive events for unsubscribed sessions', async () => {
      const ws = await connectWs(port);
      ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'a' }));
      await waitForMessage(ws);

      const received: any[] = [];
      ws.on('message', (data) => received.push(JSON.parse(data.toString())));

      manager._emit('other-session', [{ id: 'e1', type: 'log', source: 'sdk', sessionId: 'other-session', timestamp: 1 }]);

      // Give time for a message to arrive (it shouldn't)
      await new Promise((r) => setTimeout(r, 100));
      expect(received).toHaveLength(0);
      ws.close();
    });
  });

  // ── Malformed messages ──

  describe('malformed messages', () => {
    beforeEach(async () => {
      ({ server, wss, port, manager } = await startServer());
    });

    it('rejects invalid JSON', async () => {
      const ws = await connectWs(port);
      ws.send('not json{{{');
      const msg = await waitForMessage(ws);
      expect(msg.type).toBe('error');
      expect(msg.message).toBe('Invalid JSON');
      ws.close();
    });

    it('rejects missing type field', async () => {
      const ws = await connectWs(port);
      ws.send(JSON.stringify({ sessionId: 'sess-1' }));
      const msg = await waitForMessage(ws);
      expect(msg.type).toBe('error');
      expect(msg.message).toContain('Missing type or sessionId');
      ws.close();
    });

    it('rejects missing sessionId', async () => {
      const ws = await connectWs(port);
      ws.send(JSON.stringify({ type: 'subscribe' }));
      const msg = await waitForMessage(ws);
      expect(msg.type).toBe('error');
      ws.close();
    });

    it('rejects invalid sessionId format (path traversal)', async () => {
      const ws = await connectWs(port);
      ws.send(JSON.stringify({ type: 'subscribe', sessionId: '../../../etc/passwd' }));
      const msg = await waitForMessage(ws);
      expect(msg.type).toBe('error');
      expect(msg.message).toBe('Invalid sessionId');
      ws.close();
    });

    it('rejects sessionId exceeding length limit', async () => {
      const ws = await connectWs(port);
      ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'a'.repeat(200) }));
      const msg = await waitForMessage(ws);
      expect(msg.type).toBe('error');
      expect(msg.message).toBe('Invalid sessionId');
      ws.close();
    });

    it('rejects unknown message type', async () => {
      const ws = await connectWs(port);
      ws.send(JSON.stringify({ type: 'foobar', sessionId: 'sess-1' }));
      const msg = await waitForMessage(ws);
      expect(msg.type).toBe('error');
      expect(msg.message).toContain('Unknown message type');
      ws.close();
    });
  });

  // ── Rate limiting ──

  describe('rate limiting', () => {
    beforeEach(async () => {
      ({ server, wss, port, manager } = await startServer());
    });

    it('rate limits excessive messages (>20/sec)', async () => {
      const ws = await connectWs(port);

      // Send 25 messages rapidly
      for (let i = 0; i < 25; i++) {
        ws.send(JSON.stringify({ type: 'subscribe', sessionId: `sess-${i}` }));
      }

      const messages: any[] = [];
      await new Promise<void>((resolve) => {
        ws.on('message', (data) => {
          messages.push(JSON.parse(data.toString()));
          if (messages.length >= 25) resolve();
        });
        setTimeout(resolve, 500);
      });

      const errorMessages = messages.filter((m) => m.type === 'error' && m.message === 'Rate limit exceeded');
      expect(errorMessages.length).toBeGreaterThan(0);
      ws.close();
    });
  });

  // ── Auth mode ──

  describe('with auth enabled', () => {
    const jwtSecret = 'ws-test-secret';
    const apiKey = 'test-api-key-12345';
    const authConfig: AuthConfig = {
      enableAuth: true,
      apiKeys: [apiKey],
      jwtSecret,
    };

    beforeEach(async () => {
      ({ server, wss, port, manager } = await startServer(authConfig));
    });

    it('rejects connection without credentials', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const closeResult = await waitForClose(ws);
      expect(closeResult.code).toBe(1008);
    });

    it('accepts connection with valid API key as token param', async () => {
      const ws = await connectWs(port, `?token=${apiKey}`);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('accepts connection with valid JWT as token param', async () => {
      const token = signJwt({ sub: 'ws-user', permissions: ['read'] }, jwtSecret);
      const ws = await connectWs(port, `?token=${token}`);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('accepts connection with valid x-api-key header', async () => {
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const client = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { 'x-api-key': apiKey } });
        client.on('open', () => resolve(client));
        client.on('error', reject);
      });
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('rejects connection with invalid API key', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}?token=wrong-key`);
      const closeResult = await waitForClose(ws);
      expect(closeResult.code).toBe(1008);
    });

    it('rejects connection with expired JWT', async () => {
      const token = signJwt({ sub: 'user', permissions: [] }, jwtSecret, -10);
      const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`);
      const closeResult = await waitForClose(ws);
      expect(closeResult.code).toBe(1008);
    });
  });

  // ── Cleanup ──

  describe('resource cleanup on disconnect', () => {
    beforeEach(async () => {
      ({ server, wss, port, manager } = await startServer());
    });

    it('cleans up subscriptions when client disconnects', async () => {
      const ws = await connectWs(port);
      ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'sess-1' }));
      await waitForMessage(ws);
      ws.close();

      // Allow cleanup to run
      await new Promise((r) => setTimeout(r, 100));

      // Connect a second client — the first client's subscription should not receive events
      const ws2 = await connectWs(port);
      ws2.send(JSON.stringify({ type: 'subscribe', sessionId: 'sess-2' }));
      await waitForMessage(ws2);

      const received: any[] = [];
      ws2.on('message', (data) => received.push(JSON.parse(data.toString())));

      manager._emit('sess-1', [{ id: 'e1', type: 'log', source: 'sdk', sessionId: 'sess-1', timestamp: 1 }]);

      await new Promise((r) => setTimeout(r, 100));
      const sess1Events = received.filter((m) => m.sessionId === 'sess-1');
      expect(sess1Events).toHaveLength(0);
      ws2.close();
    });
  });
});
