// ============================================================
// Patterns — Named regex patterns and level mappings for log parsing
// ============================================================

import type { LogLevel } from '@probe/core';

/** Maps various level strings to normalized LogLevel */
export const LEVEL_MAP: Readonly<Record<string, LogLevel>> = {
  // Full names
  trace: 'trace',
  debug: 'debug',
  info: 'info',
  information: 'info',
  warn: 'warn',
  warning: 'warn',
  error: 'error',
  err: 'error',
  fatal: 'fatal',
  critical: 'fatal',
  severe: 'error',
  // Uppercase
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  INFORMATION: 'info',
  WARN: 'warn',
  WARNING: 'warn',
  ERROR: 'error',
  ERR: 'error',
  FATAL: 'fatal',
  CRITICAL: 'fatal',
  SEVERE: 'error',
  // Single-char abbreviations
  T: 'trace',
  D: 'debug',
  I: 'info',
  W: 'warn',
  E: 'error',
  F: 'fatal',
};

export function normalizeLevel(raw: string): LogLevel {
  return LEVEL_MAP[raw] ?? LEVEL_MAP[raw.toLowerCase()] ?? 'info';
}

// ---- Named regex patterns ----

/** Spring Boot: `2026-03-29 12:00:00.000  INFO [thread] c.p.ClassName : message` */
export const SPRING_BOOT_PATTERN =
  /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+\[([^\]]+)\]\s+([\w.]+)\s*:\s*(.*)$/;

/** Log4j bracket: `[LEVEL] loggerName - message` */
export const LOG4J_PATTERN =
  /^\[(\w+)\]\s+([\w.]+)\s+-\s+(.*)$/;

/** Syslog: `<priority>timestamp hostname app[pid]: message` */
export const SYSLOG_PATTERN =
  /^<(\d+)>(\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+(\S+?)(?:\[(\d+)\])?:\s*(.*)$/;

/** Docker log prefix: `2026-03-29T12:00:00.000000000Z stdout F message` */
export const DOCKER_PREFIX_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+(stdout|stderr)\s+\w\s+(.*)$/;

/** Stack trace continuation (Java-style or Node-style) */
export const STACK_TRACE_LINE = /^(\s+at\s+|\t+at\s+|Caused by:)/;

/** JSON detection: line starts with `{` */
export const JSON_PREFIX = /^\s*\{/;

/** Plain-text level keyword anywhere in the line */
export const PLAIN_LEVEL_PATTERN =
  /\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL|SEVERE)\b/i;

export const LOG_PATTERNS = {
  SPRING_BOOT_PATTERN,
  LOG4J_PATTERN,
  SYSLOG_PATTERN,
  DOCKER_PREFIX_PATTERN,
  STACK_TRACE_LINE,
  JSON_PREFIX,
  PLAIN_LEVEL_PATTERN,
} as const;

// ---- Format detection ----

export type LogFormat = 'json' | 'spring-boot' | 'log4j' | 'syslog' | 'plain';

/**
 * Analyzes sample lines to determine the predominant log format.
 * Returns the best-guess format name.
 */
export function detectLogFormat(sampleLines: string[]): LogFormat {
  const scores: Record<LogFormat, number> = {
    json: 0,
    'spring-boot': 0,
    log4j: 0,
    syslog: 0,
    plain: 0,
  };

  for (const line of sampleLines) {
    const trimmed = line.trim();
    if (!trimmed || STACK_TRACE_LINE.test(trimmed)) continue;

    if (JSON_PREFIX.test(trimmed)) {
      try {
        JSON.parse(trimmed);
        scores.json += 2;
        continue;
      } catch {
        // not valid JSON, fall through
      }
    }
    if (SPRING_BOOT_PATTERN.test(trimmed)) { scores['spring-boot'] += 2; continue; }
    if (LOG4J_PATTERN.test(trimmed))        { scores.log4j += 2;        continue; }
    if (SYSLOG_PATTERN.test(trimmed))       { scores.syslog += 2;       continue; }
    scores.plain += 1;
  }

  let best: LogFormat = 'plain';
  let bestScore = 0;
  for (const [fmt, score] of Object.entries(scores) as [LogFormat, number][]) {
    if (score > bestScore) { best = fmt; bestScore = score; }
  }
  return best;
}
