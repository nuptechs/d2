// ============================================================
// Timestamp utilities — Consistent high-resolution timing
// ============================================================

/** Current time in milliseconds (epoch) — standard resolution */
export function nowMs(): number {
  return Date.now();
}

/**
 * Current time in microseconds (epoch) — high resolution.
 * Anchors process.hrtime.bigint() to Date.now() at module load,
 * so results are comparable with nowMs() and other epoch timestamps.
 */
const _epochMicrosAtStart = BigInt(Date.now()) * 1000n;
const _hrtimeAtStart = process.hrtime.bigint();

export function nowMicro(): number {
  const elapsedNs = process.hrtime.bigint() - _hrtimeAtStart;
  return Number(_epochMicrosAtStart + elapsedNs / 1000n);
}

/** Format a timestamp to ISO string */
export function toIso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

/** Format a duration in ms to human-readable string */
export function formatDuration(ms: number): string {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Calculate elapsed time between two timestamps */
export function elapsed(start: number, end?: number): number {
  return (end ?? Date.now()) - start;
}
