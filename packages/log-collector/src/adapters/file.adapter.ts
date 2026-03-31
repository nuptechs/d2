// ============================================================
// FileLogAdapter — Tails a log file for new content
// Uses fs.watch() + fs.createReadStream() with byte offset tracking
// ============================================================

import { watch, createReadStream, stat } from 'node:fs';
import type { FSWatcher, ReadStream } from 'node:fs';
import { LogSourcePort } from '@probe/core/ports';
import { generateId, nowMs } from '@probe/core/utils';
import type { LogCollectorConfig, LogEvent, LogSourceInfo, LogLevel } from '@probe/core';
import { LogParser } from '../parser/log-parser.js';

export class FileLogAdapter extends LogSourcePort {
  private config: LogCollectorConfig | null = null;
  private connected = false;
  private sessionId = '';
  private watcher: FSWatcher | null = null;
  private offset = 0;
  private reading = false;
  private handlers: Array<(event: LogEvent) => void> = [];
  private parser: LogParser | null = null;
  private static readonly MAX_LINE_BUFFER = 1_048_576; // 1MB
  private lineBuffer = '';

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  async connect(config: LogCollectorConfig): Promise<void> {
    if (this.connected) await this.disconnect();
    this.config = config;

    const filePath = config.source.path;
    if (!filePath) throw new Error('FileLogAdapter requires config.source.path');

    // Get initial file size to start tailing from end
    const initialSize = await this.getFileSize(filePath);
    this.offset = initialSize;

    this.parser = new LogParser((parsed, rawLine) => {
      this.emitLogEvent(parsed, rawLine);
    });

    this.watcher = watch(filePath, () => {
      this.readNewContent(filePath);
    });

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.parser) {
      this.parser.flush();
      this.parser = null;
    }
    this.connected = false;
    this.handlers = [];
    this.offset = 0;
    this.lineBuffer = '';
    this.config = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getSourceInfo(): LogSourceInfo {
    return this.config?.source ?? { type: 'file', name: 'unknown' };
  }

  onLog(handler: (event: LogEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler);
    };
  }

  // ---- Internals ----

  private async readNewContent(filePath: string): Promise<void> {
    if (this.reading) return;
    this.reading = true;

    try {
      const currentSize = await this.getFileSize(filePath);

      // Detect file truncation (log rotation)
      if (currentSize < this.offset) {
        this.offset = 0;
      }

      if (currentSize <= this.offset) {
        this.reading = false;
        return;
      }

      const encoding = (this.config?.encoding ?? 'utf-8') as BufferEncoding;
      const stream: ReadStream = createReadStream(filePath, {
        start: this.offset,
        end: currentSize - 1,
        encoding,
      });

      const chunks: string[] = [];
      for await (const chunk of stream) {
        chunks.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString(encoding));
      }

      this.offset = currentSize;
      const data = chunks.join('');
      this.processData(data);
    } finally {
      this.reading = false;
    }
  }

  private processData(data: string): void {
    const combined = this.lineBuffer + data;
    if (combined.length > FileLogAdapter.MAX_LINE_BUFFER) {
      // Force flush oversized line to prevent unbounded memory growth
      this.parser!.feedLine(combined);
      this.lineBuffer = '';
      return;
    }
    const lines = combined.split('\n');

    // Last element is either empty (line ended with \n) or a partial line
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.length > 0) {
        this.parser!.feedLine(line);
      }
    }
  }

  private emitLogEvent(parsed: Partial<LogEvent>, rawLine: string): void {
    const config = this.config!;

    // Level filter
    if (config.levels?.length) {
      const level = parsed.level ?? 'info';
      if (!config.levels.includes(level)) return;
    }

    // Pattern filter (match any)
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

  private getFileSize(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      stat(filePath, (err, stats) => {
        if (err) {
          if (err.code === 'ENOENT') { resolve(0); return; }
          reject(err);
          return;
        }
        resolve(stats.size);
      });
    });
  }
}
