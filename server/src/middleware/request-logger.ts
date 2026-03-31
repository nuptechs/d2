// ============================================================
// Request logger middleware — structured request/response logs
// ============================================================

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';
import { randomUUID } from 'node:crypto';
import {
  parseTraceparent,
  createTraceContext,
  formatTraceparent,
} from '@probe/core';
import {
  httpRequestsTotal,
  httpRequestDuration,
  httpRequestSize,
  errorsTotal,
} from '../lib/metrics.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
      startTime?: number;
    }
  }
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  // Skip health/metrics endpoints
  if (req.path === '/health' || req.path === '/ready' || req.path === '/metrics') {
    next();
    return;
  }

  const rawRequestId = req.headers['x-request-id'] as string | undefined;
  const requestId = (
    rawRequestId
    && rawRequestId.length <= 128
    && /^[\w\-.:]+$/.test(rawRequestId)
  )
    ? rawRequestId
    : randomUUID();
  req.requestId = requestId;
  req.startTime = Date.now();
  res.setHeader('x-request-id', requestId);

  // W3C Trace Context — propagate or generate
  const incomingTrace = req.headers['traceparent'] as string | undefined;
  const traceCtx = (incomingTrace && parseTraceparent(incomingTrace)) || createTraceContext();
  const traceId = traceCtx.traceId;
  res.setHeader('traceparent', formatTraceparent(traceCtx));

  // Track request body size
  const contentLength = Number(req.headers['content-length'] || 0);
  const route = normalizeRoute(req.path);
  if (contentLength > 0) {
    httpRequestSize.observe({ method: req.method, route }, contentLength);
  }

  res.on('finish', () => {
    const duration = Date.now() - (req.startTime ?? 0);
    const durationSec = duration / 1000;
    const status = String(res.statusCode);

    // Prometheus metrics
    httpRequestsTotal.inc({ method: req.method, route, status });
    httpRequestDuration.observe({ method: req.method, route, status }, durationSec);
    if (res.statusCode >= 500) {
      errorsTotal.inc({ type: 'http_5xx' });
    }

    const logData = {
      requestId,
      traceId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    };

    if (res.statusCode >= 500) {
      logger.error(logData, 'request failed');
    } else if (res.statusCode >= 400) {
      logger.warn(logData, 'request error');
    } else {
      logger.info(logData, 'request completed');
    }
  });

  next();
}

/**
 * Normalize Express paths to avoid high-cardinality labels.
 * /api/sessions/abc123 → /api/sessions/:id
 */
function normalizeRoute(path: string): string {
  return path
    .replace(/\/api\/sessions\/[\w-]+\/events/, '/api/sessions/:id/events')
    .replace(/\/api\/sessions\/[\w-]+\/timeline/, '/api/sessions/:id/timeline')
    .replace(/\/api\/sessions\/[\w-]+\/groups/, '/api/sessions/:id/groups')
    .replace(/\/api\/sessions\/[\w-]+\/report/, '/api/sessions/:id/report')
    .replace(/\/api\/sessions\/[\w-]+\/status/, '/api/sessions/:id/status')
    .replace(/\/api\/sessions\/[\w-]+/, '/api/sessions/:id');
}
