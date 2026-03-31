// ============================================================
// Logger — Structured logging with pino
// ============================================================

import pino from 'pino';

const level = process.env['LOG_LEVEL'] ?? (process.env['NODE_ENV'] === 'production' ? 'info' : 'debug');

export const logger = pino({
  level,
  transport: process.env['NODE_ENV'] !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
    : undefined,
  base: { service: 'probe-server', version: '0.1.0' },
  serializers: pino.stdSerializers,
});

export type Logger = pino.Logger;
