// ============================================================
// LogParser — Multi-format log line parser
// Detects JSON, Spring Boot, Log4j, Syslog, plain text
// ============================================================

import type { LogLevel } from '@probe/core';
import {
  SPRING_BOOT_PATTERN,
  LOG4J_PATTERN,
  SYSLOG_PATTERN,
  JSON_PREFIX,
  STACK_TRACE_LINE,
  PLAIN_LEVEL_PATTERN,
  normalizeLevel,
} from './patterns.js';

/** Fields that can be extracted from a log line (mutable for parser use) */
export interface ParsedLine {
  level?: LogLevel;
  message?: string;
  loggerName?: string;
  threadName?: string;
  sourceFile?: string;
  sourceLine?: number;
  stackTrace?: string;
  structured?: Record<string, unknown>;
}

/** Stateless: parse a single log line */
export function parseLogLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return { level: 'info', message: '' };

  // 1) JSON structured logs
  if (JSON_PREFIX.test(trimmed)) {
    const parsed = tryParseJson(trimmed);
    if (parsed) return parsed;
  }

  // 2) Spring Boot
  const spring = trySpringBoot(trimmed);
  if (spring) return spring;

  // 3) Log4j bracket format
  const log4j = tryLog4j(trimmed);
  if (log4j) return log4j;

  // 4) Syslog
  const syslog = trySyslog(trimmed);
  if (syslog) return syslog;

  // 5) Plain text fallback
  return parsePlainText(trimmed);
}

// ---- JSON ----

function tryParseJson(line: string): ParsedLine | null {
  try {
    const obj = JSON.parse(line);
    if (typeof obj !== 'object' || obj === null) return null;

    const level = extractJsonLevel(obj);
    const message = extractJsonMessage(obj);

    const result: ParsedLine = { level, message };

    if (typeof obj.logger === 'string')     result.loggerName = obj.logger;
    if (typeof obj.loggerName === 'string')  result.loggerName = obj.loggerName;
    if (typeof obj.name === 'string' && !result.loggerName) result.loggerName = obj.name;

    if (typeof obj.thread === 'string')     result.threadName = obj.thread;
    if (typeof obj.threadName === 'string') result.threadName = obj.threadName;

    if (typeof obj.file === 'string')       result.sourceFile = obj.file;
    if (typeof obj.fileName === 'string')   result.sourceFile = obj.fileName;
    if (typeof obj.line === 'number')       result.sourceLine = obj.line;
    if (typeof obj.lineNumber === 'number') result.sourceLine = obj.lineNumber;

    if (typeof obj.stack === 'string')      result.stackTrace = obj.stack;
    if (typeof obj.stackTrace === 'string') result.stackTrace = obj.stackTrace;
    if (typeof obj.err?.stack === 'string') result.stackTrace = obj.err.stack;

    // Remaining fields → structured
    const known = new Set([
      'level', 'msg', 'message', 'timestamp', 'time', 'ts', '@timestamp',
      'logger', 'loggerName', 'name', 'thread', 'threadName',
      'file', 'fileName', 'line', 'lineNumber', 'stack', 'stackTrace', 'err',
    ]);
    const extra: Record<string, unknown> = {};
    let hasExtra = false;
    for (const [k, v] of Object.entries(obj)) {
      if (!known.has(k)) { extra[k] = v; hasExtra = true; }
    }
    if (hasExtra) result.structured = extra;

    return result;
  } catch {
    return null;
  }
}

function extractJsonLevel(obj: Record<string, unknown>): LogLevel {
  const raw = obj.level ?? obj.severity ?? obj.lvl;
  if (typeof raw === 'string') return normalizeLevel(raw);
  if (typeof raw === 'number') {
    // pino-style numeric levels
    if (raw <= 10) return 'trace';
    if (raw <= 20) return 'debug';
    if (raw <= 30) return 'info';
    if (raw <= 40) return 'warn';
    if (raw <= 50) return 'error';
    return 'fatal';
  }
  return 'info';
}

function extractJsonMessage(obj: Record<string, unknown>): string {
  if (typeof obj.msg === 'string') return obj.msg;
  if (typeof obj.message === 'string') return obj.message;
  if (typeof obj.text === 'string') return obj.text;
  return '';
}

// ---- Spring Boot ----

function trySpringBoot(line: string): ParsedLine | null {
  const m = SPRING_BOOT_PATTERN.exec(line);
  if (!m) return null;
  return {
    level: normalizeLevel(m[2]!),
    threadName: m[3],
    loggerName: m[4],
    message: m[5] ?? '',
  };
}

// ---- Log4j ----

function tryLog4j(line: string): ParsedLine | null {
  const m = LOG4J_PATTERN.exec(line);
  if (!m) return null;
  return {
    level: normalizeLevel(m[1]!),
    loggerName: m[2],
    message: m[3] ?? '',
  };
}

// ---- Syslog ----

const SYSLOG_SEVERITY_MAP: LogLevel[] = [
  'fatal',  // 0 - Emergency
  'fatal',  // 1 - Alert
  'fatal',  // 2 - Critical
  'error',  // 3 - Error
  'warn',   // 4 - Warning
  'info',   // 5 - Notice
  'info',   // 6 - Informational
  'debug',  // 7 - Debug
];

function trySyslog(line: string): ParsedLine | null {
  const m = SYSLOG_PATTERN.exec(line);
  if (!m) return null;
  const priority = parseInt(m[1]!, 10);
  const severity = priority & 0x07;
  return {
    level: SYSLOG_SEVERITY_MAP[severity] ?? 'info',
    loggerName: m[4],
    message: m[6] ?? '',
  };
}

// ---- Plain text fallback ----

function parsePlainText(line: string): ParsedLine {
  const levelMatch = PLAIN_LEVEL_PATTERN.exec(line);
  const level: LogLevel = levelMatch ? normalizeLevel(levelMatch[1]!) : 'info';
  return { level, message: line };
}

// ---- Stateful parser (tracks stack traces across lines) ----

export class LogParser {
  private pendingEvent: ParsedLine | null = null;
  private pendingRaw = '';
  private readonly flushCallback: (parsed: ParsedLine, rawLine: string) => void;

  constructor(onEvent: (parsed: ParsedLine, rawLine: string) => void) {
    this.flushCallback = onEvent;
  }

  /** Feed a single line. May buffer if it's a stack trace continuation. */
  feedLine(line: string): void {
    if (STACK_TRACE_LINE.test(line)) {
      // Append to pending event's stack trace
      if (this.pendingEvent) {
        this.pendingEvent.stackTrace =
          (this.pendingEvent.stackTrace ? this.pendingEvent.stackTrace + '\n' : '') + line;
        this.pendingRaw += '\n' + line;
        return;
      }
    }

    // Flush previous pending event
    this.flush();

    // Parse new line
    this.pendingEvent = parseLogLine(line);
    this.pendingRaw = line;
  }

  /** Flush any buffered event */
  flush(): void {
    if (this.pendingEvent) {
      this.flushCallback(this.pendingEvent, this.pendingRaw);
      this.pendingEvent = null;
      this.pendingRaw = '';
    }
  }
}
