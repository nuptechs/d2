// ============================================================
// StdoutLogAdapter — Wraps a Node.js Readable stream
// Suitable for process.stdout, process.stderr, or custom streams
// ============================================================

import type { Readable } from 'node:stream';
import { LogSourcePort } from '@probe/core/ports';
import { generateId, nowMs } from '@probe/core/utils';
import type { LogCollectorConfig, LogEvent, LogSourceInfo, LogLevel } from '@probe/core';
import { LogParser } from '../parser/log-parser.js';

export class StdoutLogAdapter extends LogSourcePort {
  private config: LogCollectorConfig | null = null;
  private connected = false;
  private sessionId = '';
  private stream: Readable | null = null;
  private handlers: Array<(event: LogEvent) => void> = [];
  private parser: LogParser | null = null;
  private lineBuffer = '';
  private onData: ((chunk: Buffer | string) => void) | null = null;
  private onEnd: (() => void) | null = null;

  constructor(private readonly inputStream: Readable) {
    super();
  }

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  async connect(config: LogCollectorConfig): Promise<void> {
    if (this.connected) await this.disconnect();
    this.config = config;
    this.stream = this.inputStream;

    this.parser = new LogParser((parsed, rawLine) => {
      this.emitLogEvent(parsed, rawLine);
    });

    const encoding = (config.encoding ?? 'utf-8') as BufferEncoding;

    this.onData = (chunk: Buffer | string) => {
      const data = typeof chunk === 'string' ? chunk : chunk.toString(encoding);
      this.processData(data);
    };

    this.onEnd = () => {
      this.parser?.flush();
      this.connected = false;
    };

    this.stream.on('data', this.onData);
    this.stream.on('end', this.onEnd);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.stream && this.onData) {
      this.stream.removeListener('data', this.onData);
    }
    if (this.stream && this.onEnd) {
      this.stream.removeListener('end', this.onEnd);
    }
    this.parser?.flush();
    this.parser = null;
    this.stream = null;
    this.onData = null;
    this.onEnd = null;
    this.lineBuffer = '';
    this.connected = false;
    this.handlers = [];
    this.config = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getSourceInfo(): LogSourceInfo {
    return this.config?.source ?? { type: 'stdout', name: 'unknown' };
  }

  onLog(handler: (event: LogEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler);
    };
  }

  // ---- Internals ----

  private processData(data: string): void {
    const combined = this.lineBuffer + data;
    const lines = combined.split('\n');
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.length > 0) {
        this.parser!.feedLine(line);
      }
    }
  }

  private emitLogEvent(parsed: Partial<LogEvent>, rawLine: string): void {
    const config = this.config!;

    if (config.levels?.length) {
      const level = parsed.level ?? 'info';
      if (!config.levels.includes(level)) return;
    }

    if (config.patterns?.length) {
      const matches = config.patterns.some(p => rawLine.includes(p));
      if (!matches) return;
    }

    const event: LogEvent = {
      id: generateId(),
      sessionId: this.sessionId,
      timestamp: nowMs(),
      source: 'log',
      level: (parsed.level ?? 'info') as LogLevel,
      message: parsed.message ?? rawLine,
      loggerName: parsed.loggerName,
      threadName: parsed.threadName,
      sourceFile: parsed.sourceFile,
      sourceLine: parsed.sourceLine,
      stackTrace: parsed.stackTrace,
      structured: parsed.structured as Readonly<Record<string, unknown>> | undefined,
      rawLine,
      logSource: config.source,
    };

    for (const handler of this.handlers) {
      handler(event);
    }
  }
}
