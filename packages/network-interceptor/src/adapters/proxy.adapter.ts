// ============================================================
// ProxyAdapter — HTTP proxy server for traffic capture
// ============================================================

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { URL } from 'node:url';
import {
  NetworkCapturePort,
  generateId,
  generateRequestId,
  nowMs,
  redactHeaders,
  redactBody,
} from '@probe/core';
import type { NetworkConfig, RequestEvent, ResponseEvent, HttpMethod } from '@probe/core';
import { createTrafficFilter } from '../filters/traffic-filter.js';

const DEFAULT_PROXY_PORT = 8080;
const REQUEST_TTL_MS = 120_000; // 2 minutes
const CLEANUP_INTERVAL_MS = 30_000;

const CAPTURABLE_CONTENT_TYPES = new Set([
  'text/plain', 'text/html', 'text/css', 'text/xml', 'text/csv',
  'application/json', 'application/xml', 'application/x-www-form-urlencoded',
]);

function isCapturableBody(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return CAPTURABLE_CONTENT_TYPES.has(base) || base.startsWith('text/');
}

interface PendingRequest {
  requestId: string;
  startTime: number;
  method: string;
  url: string;
}

export class ProxyAdapter extends NetworkCapturePort {
  private server: http.Server | null = null;
  private capturing = false;
  private config: NetworkConfig | null = null;
  private sessionId = '';
  private shouldCapture: (url: string) => boolean = () => true;

  private requestHandlers: Array<(event: RequestEvent) => void> = [];
  private responseHandlers: Array<(event: ResponseEvent) => void> = [];

  private pendingRequests = new Map<string, PendingRequest>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private activeConnections = new Set<http.ServerResponse>();

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  async start(config: NetworkConfig): Promise<void> {
    if (this.capturing) return;
    this.config = config;
    this.shouldCapture = createTrafficFilter(config);
    this.startCleanupTimer();

    const port = config.proxyPort ?? DEFAULT_PROXY_PORT;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    // Handle HTTPS CONNECT tunneling — pass-through, no SSL interception
    this.server.on('connect', (req, clientSocket, head) => {
      const [hostname, portStr] = (req.url ?? '').split(':');
      const targetPort = parseInt(portStr ?? '443', 10);

      const serverSocket = net.connect(targetPort, hostname ?? '', () => {
        clientSocket.write(
          'HTTP/1.1 200 Connection Established\r\n\r\n',
        );
        serverSocket.write(head);
        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
      });

      serverSocket.on('error', () => {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      });

      clientSocket.on('error', () => {
        serverSocket.destroy();
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, () => resolve());
      this.server!.once('error', reject);
    });

    this.capturing = true;
  }

  async stop(): Promise<void> {
    if (!this.capturing || !this.server) return;
    this.capturing = false;

    this.stopCleanupTimer();

    // Close active connections
    for (const res of this.activeConnections) {
      res.destroy();
    }
    this.activeConnections.clear();
    this.pendingRequests.clear();

    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });

    this.server = null;
    this.requestHandlers = [];
    this.responseHandlers = [];
  }

  isCapturing(): boolean {
    return this.capturing;
  }

  onRequest(handler: (event: RequestEvent) => void): () => void {
    this.requestHandlers.push(handler);
    return () => {
      this.requestHandlers = this.requestHandlers.filter(h => h !== handler);
    };
  }

  onResponse(handler: (event: ResponseEvent) => void): () => void {
    this.responseHandlers.push(handler);
    return () => {
      this.responseHandlers = this.responseHandlers.filter(h => h !== handler);
    };
  }

  // ---- Internal ----

  private handleRequest(clientReq: http.IncomingMessage, clientRes: http.ServerResponse): void {
    const targetUrl = clientReq.url ?? '/';
    const method = (clientReq.method ?? 'GET') as HttpMethod | string;

    // Apply traffic filter
    if (!this.shouldCapture(targetUrl)) {
      this.forwardRequest(clientReq, clientRes, targetUrl);
      return;
    }

    this.activeConnections.add(clientRes);
    clientRes.on('close', () => this.activeConnections.delete(clientRes));

    const requestId = generateRequestId();
    const startTime = nowMs();

    this.pendingRequests.set(requestId, {
      requestId,
      startTime,
      method,
      url: targetUrl,
    });

    // Collect request body
    const bodyChunks: Buffer[] = [];
    let bodySize = 0;
    const captureBody = this.config?.captureBody ?? false;
    const maxBodySize = this.config?.maxBodySize ?? 1_048_576;
    const reqContentType = clientReq.headers['content-type'];
    const shouldCaptureReqBody = captureBody && isCapturableBody(reqContentType);

    clientReq.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (shouldCaptureReqBody && bodySize <= maxBodySize) {
        bodyChunks.push(chunk);
      }
    });

    clientReq.on('end', () => {
      let body: string | undefined;
      if (shouldCaptureReqBody && bodyChunks.length > 0) {
        const raw = Buffer.concat(bodyChunks).toString('utf-8');
        body = bodySize > maxBodySize ? raw.slice(0, maxBodySize) + '[TRUNCATED]' : raw;
        body = redactBody(body);
      }

      const headers = this.flattenHeaders(clientReq.headers);

      const requestEvent: RequestEvent = {
        id: generateId(),
        sessionId: this.sessionId,
        timestamp: startTime,
        source: 'network',
        type: 'request',
        requestId,
        method,
        url: targetUrl,
        headers: redactHeaders(headers),
        body,
        bodySize: bodySize || undefined,
      };

      this.emitRequest(requestEvent);
    });

    // Forward the request to the actual target
    this.forwardAndCapture(clientReq, clientRes, targetUrl, requestId, startTime);
  }

  private forwardAndCapture(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    targetUrl: string,
    requestId: string,
    startTime: number,
  ): void {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
      clientRes.end('Bad Request: Invalid target URL');
      this.pendingRequests.delete(requestId);
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const proxyReq = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: clientReq.method,
        headers: clientReq.headers,
      },
      (proxyRes) => {
        this.handleProxyResponse(proxyRes, clientRes, requestId, startTime);
      },
    );

    proxyReq.on('error', (err) => {
      this.pendingRequests.delete(requestId);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
        clientRes.end(`Bad Gateway: ${err.message}`);
      }
    });

    clientReq.pipe(proxyReq);
  }

  private handleProxyResponse(
    proxyRes: http.IncomingMessage,
    clientRes: http.ServerResponse,
    requestId: string,
    startTime: number,
  ): void {
    const statusCode = proxyRes.statusCode ?? 0;
    const statusText = proxyRes.statusMessage ?? '';
    const resContentType = proxyRes.headers['content-type'];
    const captureBody = this.config?.captureBody ?? false;
    const maxBodySize = this.config?.maxBodySize ?? 1_048_576;
    const shouldCaptureResBody = captureBody && isCapturableBody(resContentType);

    const bodyChunks: Buffer[] = [];
    let bodySize = 0;

    // Forward status + headers to client
    clientRes.writeHead(statusCode, proxyRes.headers);

    proxyRes.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (shouldCaptureResBody && bodySize <= maxBodySize) {
        bodyChunks.push(chunk);
      }
      clientRes.write(chunk);
    });

    proxyRes.on('end', () => {
      clientRes.end();

      const duration = nowMs() - startTime;
      const headers = this.flattenHeaders(proxyRes.headers);

      let body: string | undefined;
      if (shouldCaptureResBody && bodyChunks.length > 0) {
        const raw = Buffer.concat(bodyChunks).toString('utf-8');
        body = bodySize > maxBodySize ? raw.slice(0, maxBodySize) + '[TRUNCATED]' : raw;
        body = redactBody(body);
      }

      const responseEvent: ResponseEvent = {
        id: generateId(),
        sessionId: this.sessionId,
        timestamp: nowMs(),
        source: 'network',
        type: 'response',
        requestId,
        statusCode,
        statusText,
        headers: redactHeaders(headers),
        body,
        bodySize: bodySize || undefined,
        duration,
      };

      this.pendingRequests.delete(requestId);
      this.emitResponse(responseEvent);
    });
  }

  private forwardRequest(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    targetUrl: string,
  ): void {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
      clientRes.end('Bad Request');
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const proxyReq = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: clientReq.method,
        headers: clientReq.headers,
      },
      (proxyRes) => {
        clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(clientRes);
      },
    );

    proxyReq.on('error', () => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
        clientRes.end('Bad Gateway');
      }
    });

    clientReq.pipe(proxyReq);
  }

  private flattenHeaders(
    headers: http.IncomingHttpHeaders,
  ): Record<string, string> {
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      flat[key] = Array.isArray(value) ? value.join(', ') : value;
    }
    return flat;
  }

  private emitRequest(event: RequestEvent): void {
    for (const handler of this.requestHandlers) {
      handler(event);
    }
  }

  private emitResponse(event: ResponseEvent): void {
    for (const handler of this.responseHandlers) {
      handler(event);
    }
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      const now = nowMs();
      for (const [id, pending] of this.pendingRequests) {
        if (now - pending.startTime > REQUEST_TTL_MS) {
          this.pendingRequests.delete(id);
        }
      }
    }, CLEANUP_INTERVAL_MS);

    // Don't keep the process alive just for cleanup
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  private stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
