// ============================================================
// Global error handler — Last middleware in Express chain
// ============================================================

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';

interface AppError extends Error {
  statusCode?: number;
  code?: string;
}

export function errorHandler(err: AppError, req: Request, res: Response, _next: NextFunction): void {
  const statusCode = err.statusCode ?? 500;
  const message = statusCode === 500 ? 'Internal server error' : err.message;

  const logData = {
    requestId: req.requestId,
    status: statusCode,
    code: err.code,
    path: req.path,
    method: req.method,
  };

  if (statusCode >= 500) {
    logger.error({ ...logData, err }, 'unhandled error');
  } else {
    logger.warn(logData, err.message);
  }

  if (!res.headersSent) {
    res.status(statusCode).json({ error: message });
  }
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Not found' });
}
