// ============================================================
// MiddlewareAdapter — Express-compatible HTTP capture middleware
// ============================================================

import {
  NetworkCapturePort,
  generateId,
  generateRequestId,
  nowMs,
  redactHeaders,
  redactBody,
} from '@probe/core';
import type {
  NetworkConfig,
  RequestEvent,
  ResponseEvent,
  HttpMethod,
} from '@probe/core';
import { createTrafficFilter } from '../filters/traffic-filter.js';

// Minimal Express-compatible types (avoid importing express as a dependency)
interface IncomingMessage {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

interface ServerResponse {
  statusCode: number;
  statusMessage: string;
  getHeaders(): Record<string, string | string[] | number | undefined>;
  write(chunk: unknown, ...args: unknown[]): boolean;
  end(...args: unknown[]): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

type NextFunction = (err?: unknown) => void;

const CAPTURABLE_CONTENT_TYPES = new Set([
  'text/plain', 'text/html', 'text/css', 'text/xml', 'text/csv',
  'application/json', 'application/xml', 'application/x-www-form-urlencoded',
]);

function isCapturableBody(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return CAPTURABLE_CONTENT_TYPES.has(base) || base.startsWith('text/');
}

export class MiddlewareAdapter extends NetworkCapturePort {
  private capturing = false;
  private config: NetworkConfig | null = null;
  private sessionId = '';
  private shouldCapture: (url: string) => boolean = () => true;

  private requestHandlers: Array<(event: RequestEvent) => void> = [];
  private responseHandlers: Array<(event: ResponseEvent) => void> = [];

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  /** start() is a no-op — middleware is passive, activated when mounted. */
  async start(config: NetworkConfig): Promise<void> {
    this.config = config;
    this.shouldCapture = createTrafficFilter(config);
    this.capturing = true;
  }

  /** stop() clears all handlers and stops event emission. */
  async stop(): Promise<void> {
    this.capturing = false;
    this.requestHandlers = [];
    this.responseHandlers = [];
    this.config = null;
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

  /**
   * Returns an Express-compatible middleware function.
   * Mount it early in the middleware chain to capture all traffic.
   *
   * ```ts
   * const adapter = new MiddlewareAdapter();
   * await adapter.start(config);
   * app.use(adapter.getMiddleware());
   * ```
   */
  getMiddleware(): (req: IncomingMessage, res: ServerResponse, next: NextFunction) => void {
    return (req: IncomingMessage, res: ServerResponse, next: NextFunction): void => {
      if (!this.capturing) {
        next();
        return;
      }

      const url = req.url ?? '/';
      if (!this.shouldCapture(url)) {
        next();
        return;
      }

      const requestId = generateRequestId();
      const startTime = nowMs();
      const method = (req.method ?? 'GET') as HttpMethod | string;
      const captureBody = this.config?.captureBody ?? false;
      const maxBodySize = this.config?.maxBodySize ?? 1_048_576;

      // ---- Capture request body ----
      const reqContentType = this.getHeader(req.headers, 'content-type');
      const shouldCaptureReqBody = captureBody && isCapturableBody(reqContentType);
      const reqBodyChunks: Buffer[] = [];
      let reqBodySize = 0;

      req.on('data', (chunk: unknown) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        reqBodySize += buf.length;
        if (shouldCaptureReqBody && reqBodySize <= maxBodySize) {
          reqBodyChunks.push(buf);
        }
      });

      req.on('end', () => {
        let body: string | undefined;
        if (shouldCaptureReqBody && reqBodyChunks.length > 0) {
          const raw = Buffer.concat(reqBodyChunks).toString('utf-8');
          body = reqBodySize > maxBodySize
            ? raw.slice(0, maxBodySize) + '[TRUNCATED]'
            : raw;
          body = redactBody(body);
        }

        const headers = this.flattenHeaders(req.headers);

        const requestEvent: RequestEvent = {
          id: generateId(),
          sessionId: this.sessionId,
          timestamp: startTime,
          source: 'network',
          type: 'request',
          requestId,
          method,
          url,
          headers: redactHeaders(headers),
          body,
          bodySize: reqBodySize || undefined,
        };

        this.emitRequest(requestEvent);
      });

      // ---- Capture response body by wrapping res.write() and res.end() ----
      const resBodyChunks: Buffer[] = [];
      let resBodySize = 0;
      const originalWrite = res.write.bind(res) as (...args: unknown[]) => boolean;
      const originalEnd = res.end.bind(res) as (...args: unknown[]) => void;

      res.write = (chunk: unknown, ...args: unknown[]): boolean => {
        if (chunk != null) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          resBodySize += buf.length;
          if (captureBody && resBodySize <= maxBodySize) {
            resBodyChunks.push(buf);
          }
        }
        return originalWrite(chunk, ...args);
      };

      res.end = (...args: unknown[]): void => {
        // Capture final chunk passed to end()
        const firstArg = args[0];
        if (firstArg != null && typeof firstArg !== 'function') {
          const buf = Buffer.isBuffer(firstArg) ? firstArg : Buffer.from(String(firstArg));
          resBodySize += buf.length;
          if (captureBody && resBodySize <= maxBodySize) {
            resBodyChunks.push(buf);
          }
        }

        originalEnd(...args);

        // Emit response event after response completes
        const duration = nowMs() - startTime;
        const resContentType = this.getResponseHeader(res, 'content-type');
        const shouldCaptureResBody = captureBody && isCapturableBody(resContentType);

        let body: string | undefined;
        if (shouldCaptureResBody && resBodyChunks.length > 0) {
          const raw = Buffer.concat(resBodyChunks).toString('utf-8');
          body = resBodySize > maxBodySize
            ? raw.slice(0, maxBodySize) + '[TRUNCATED]'
            : raw;
          body = redactBody(body);
        }

        const headers = this.flattenResponseHeaders(res);

        const responseEvent: ResponseEvent = {
          id: generateId(),
          sessionId: this.sessionId,
          timestamp: nowMs(),
          source: 'network',
          type: 'response',
          requestId,
          statusCode: res.statusCode,
          statusText: res.statusMessage ?? '',
          headers: redactHeaders(headers),
          body,
          bodySize: resBodySize || undefined,
          duration,
        };

        this.emitResponse(responseEvent);
      };

      next();
    };
  }

  // ---- Helpers ----

  private flattenHeaders(
    headers: Record<string, string | string[] | undefined>,
  ): Record<string, string> {
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      flat[key] = Array.isArray(value) ? value.join(', ') : value;
    }
    return flat;
  }

  private flattenResponseHeaders(res: ServerResponse): Record<string, string> {
    const raw = res.getHeaders();
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined) continue;
      flat[key] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return flat;
  }

  private getHeader(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): string | undefined {
    const val = headers[name] ?? headers[name.toLowerCase()];
    if (val === undefined) return undefined;
    return Array.isArray(val) ? val[0] : val;
  }

  private getResponseHeader(res: ServerResponse, name: string): string | undefined {
    const raw = res.getHeaders();
    const val = raw[name] ?? raw[name.toLowerCase()];
    if (val === undefined) return undefined;
    return Array.isArray(val) ? val[0] : String(val);
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
}
