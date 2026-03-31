// ============================================================
// WebSocket realtime — Event streaming to subscribed clients
// ============================================================

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ProbeEvent } from '@probe/core';
import type { SessionManager } from '../services/session-manager.js';
import type { AuthConfig } from '../middleware/auth.js';
import { verifyJwt, timingSafeKeyCheck } from '../middleware/auth.js';
import { logger } from '../logger.js';

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
const MAX_MESSAGE_SIZE = 4096; // 4KB max for control messages
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX = 20; // max 20 messages per second
const MAX_CONNECTIONS_PER_IP = 50;

export function setupWebSocket(server: HttpServer, sessionManager: SessionManager, authConfig?: AuthConfig): WebSocketServer {
  const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_SIZE });
  const subscriptions = new Map<WebSocket, Set<string>>();
  const alive = new Map<WebSocket, boolean>();
  const messageCounts = new Map<WebSocket, { count: number; resetAt: number }>();
  const connectionsPerIp = new Map<string, number>();
  const wsToIp = new Map<WebSocket, string>();

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

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // ── Auth check — WS cannot set headers from browsers, so accept query param ──
    if (authConfig?.enableAuth) {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const tokenParam = url.searchParams.get('token') ?? '';
      const apiKeyHeader = (req.headers['x-api-key'] as string) ?? '';

      let authenticated = false;

      // Check x-api-key header (non-browser clients) — timing-safe
      if (apiKeyHeader && timingSafeKeyCheck(authConfig.apiKeys, apiKeyHeader)) {
        authenticated = true;
      }
      // Check token query param — could be API key or JWT
      if (!authenticated && tokenParam) {
        if (timingSafeKeyCheck(authConfig.apiKeys, tokenParam)) {
          authenticated = true;
        } else if (authConfig.jwtSecret) {
          const payload = verifyJwt(tokenParam, authConfig.jwtSecret);
          if (payload) authenticated = true;
        }
      }

      if (!authenticated) {
        logger.warn({ ip: req.socket.remoteAddress }, 'WebSocket connection rejected: unauthorized');
        ws.close(1008, 'Unauthorized');
        return;
      }
    }

    // Per-IP connection limit
    const ip = req.socket.remoteAddress ?? 'unknown';
    const currentCount = connectionsPerIp.get(ip) ?? 0;
    if (currentCount >= MAX_CONNECTIONS_PER_IP) {
      logger.warn({ ip, connections: currentCount }, 'WebSocket connection limit exceeded');
      ws.close(1008, 'Too many connections');
      return;
    }
    connectionsPerIp.set(ip, currentCount + 1);
    wsToIp.set(ws, ip);

    // Origin validation — reject cross-origin WebSocket hijacking
    const allowedOrigins = (process.env['CORS_ORIGINS'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (allowedOrigins.length > 0) {
      const origin = req.headers.origin ?? '';
      if (!allowedOrigins.includes(origin)) {
        logger.warn({ origin, ip: req.socket.remoteAddress }, 'WebSocket connection rejected: invalid origin');
        ws.close(1008, 'Invalid origin');
        return;
      }
    }

    subscriptions.set(ws, new Set());
    alive.set(ws, true);

    ws.on('pong', () => {
      alive.set(ws, true);
    });

    ws.on('message', (data: Buffer | string) => {
      // Rate limiting
      const now = Date.now();
      let rate = messageCounts.get(ws);
      if (!rate || now >= rate.resetAt) {
        rate = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
        messageCounts.set(ws, rate);
      }
      rate.count++;
      if (rate.count > RATE_LIMIT_MAX) {
        logger.warn({ ip: req.socket.remoteAddress, count: rate.count }, 'WebSocket rate limit exceeded');
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }));
        return;
      }

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

      // Validate sessionId format — alphanumeric + dashes only
      if (msg.sessionId.length > 128 || !/^[\w-]+$/.test(msg.sessionId)) {
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
    const wsIp = wsToIp.get(ws);
    if (wsIp) {
      const count = (connectionsPerIp.get(wsIp) ?? 1) - 1;
      if (count <= 0) connectionsPerIp.delete(wsIp);
      else connectionsPerIp.set(wsIp, count);
      wsToIp.delete(ws);
    }
    subscriptions.delete(ws);
    alive.delete(ws);
    messageCounts.delete(ws);
  }

  return wss;
}
