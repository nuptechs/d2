// ============================================================
// WebSocket realtime — Event streaming to subscribed clients
// ============================================================

import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ProbeEvent } from '@probe/core';
import type { SessionManager } from '../services/session-manager.js';

interface SubscribeMessage {
  type: 'subscribe';
  sessionId: string;
}

interface UnsubscribeMessage {
  type: 'unsubscribe';
  sessionId: string;
}

type ClientMessage = SubscribeMessage | UnsubscribeMessage;

interface ServerEventMessage {
  type: 'event';
  sessionId: string;
  event: ProbeEvent;
}

interface ServerGroupMessage {
  type: 'group';
  sessionId: string;
  group: unknown;
}

type ServerMessage = ServerEventMessage | ServerGroupMessage;

const PING_INTERVAL_MS = 30_000;

export function setupWebSocket(server: HttpServer, sessionManager: SessionManager): void {
  const wss = new WebSocketServer({ server });
  const subscriptions = new Map<WebSocket, Set<string>>();
  const alive = new Map<WebSocket, boolean>();

  // Event ingestion listener — push to subscribers
  sessionManager.onEventsIngested((sessionId: string, events: ProbeEvent[]) => {
    for (const [ws, subs] of subscriptions) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!subs.has(sessionId)) continue;

      for (const event of events) {
        const msg: ServerMessage = { type: 'event', sessionId, event };
        ws.send(JSON.stringify(msg));
      }
    }
  });

  // Ping/pong keepalive
  const pingInterval = setInterval(() => {
    for (const [ws, isAlive] of alive) {
      if (!isAlive) {
        ws.terminate();
        cleanup(ws);
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, PING_INTERVAL_MS);

  wss.on('close', () => {
    clearInterval(pingInterval);
  });

  wss.on('connection', (ws: WebSocket) => {
    subscriptions.set(ws, new Set());
    alive.set(ws, true);

    ws.on('pong', () => {
      alive.set(ws, true);
    });

    ws.on('message', (data: Buffer | string) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf-8')) as ClientMessage;
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      if (!msg.type || !msg.sessionId || typeof msg.sessionId !== 'string') {
        ws.send(JSON.stringify({ type: 'error', message: 'Missing type or sessionId' }));
        return;
      }

      // Validate sessionId format (basic check)
      if (msg.sessionId.length > 128) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid sessionId' }));
        return;
      }

      const subs = subscriptions.get(ws);
      if (!subs) return;

      switch (msg.type) {
        case 'subscribe':
          subs.add(msg.sessionId);
          ws.send(JSON.stringify({ type: 'subscribed', sessionId: msg.sessionId }));
          break;
        case 'unsubscribe':
          subs.delete(msg.sessionId);
          ws.send(JSON.stringify({ type: 'unsubscribed', sessionId: msg.sessionId }));
          break;
        default:
          ws.send(JSON.stringify({ type: 'error', message: `Unknown message type` }));
      }
    });

    ws.on('close', () => cleanup(ws));
    ws.on('error', () => cleanup(ws));
  });

  function cleanup(ws: WebSocket): void {
    subscriptions.delete(ws);
    alive.delete(ws);
  }
}
