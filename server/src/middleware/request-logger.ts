// ============================================================
// Request logger middleware — structured request/response logs
// ============================================================

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';
import { randomUUID } from 'node:crypto';

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
  // Skip health endpoints
  if (req.path === '/health' || req.path === '/ready') {
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

  res.on('finish', () => {
    const duration = Date.now() - (req.startTime ?? 0);
    const logData = {
      requestId,
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
