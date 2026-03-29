// ============================================================
// ID Generation — Collision-resistant unique identifiers
// Uses crypto.randomUUID when available, falls back to manual
// ============================================================

import { randomBytes, randomUUID } from 'node:crypto';

/** Generate a UUID v4 */
export function generateId(): string {
  return randomUUID();
}

/** Generate a short ID (8 hex chars) — for display purposes only */
export function generateShortId(): string {
  return randomBytes(4).toString('hex');
}

/** Generate a correlation ID (prefixed for easy identification in logs/headers) */
export function generateCorrelationId(): string {
  return `probe-${randomBytes(8).toString('hex')}`;
}

/** Generate a session ID (prefixed) */
export function generateSessionId(): string {
  return `sess-${randomUUID()}`;
}

/** Generate a request ID (prefixed) */
export function generateRequestId(): string {
  return `req-${randomBytes(6).toString('hex')}`;
}
