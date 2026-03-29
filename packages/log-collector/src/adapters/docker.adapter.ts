// ============================================================
// DockerLogAdapter — Follows Docker container logs via child process
// Spawns `docker logs --follow --tail 0 <containerId>`
// ============================================================

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { LogSourcePort } from '@probe/core/ports';
import { generateId, nowMs } from '@probe/core/utils';
import type { LogCollectorConfig, LogEvent, LogSourceInfo, LogLevel } from '@probe/core';
import { LogParser } from '../parser/log-parser.js';
import { DOCKER_PREFIX_PATTERN } from '../parser/patterns.js';

export class DockerLogAdapter extends LogSourcePort {
  private config: LogCollectorConfig | null = null;
  private connected = false;
  private sessionId = '';
  private child: ChildProcess | null = null;
  private handlers: Array<(event: LogEvent) => void> = [];
  private stdoutParser: LogParser | null = null;
  private stderrParser: LogParser | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  async connect(config: LogCollectorConfig): Promise<void> {
    if (this.connected) await this.disconnect();
    this.config = config;

    const containerId = config.source.containerId;
    if (!containerId) throw new Error('DockerLogAdapter requires config.source.containerId');

    // Validate container exists
    await this.validateContainer(containerId);

    this.stdoutParser = new LogParser((parsed, rawLine) => {
      this.emitLogEvent(parsed, rawLine);
    });
    this.stderrParser = new LogParser((parsed, rawLine) => {
      // stderr lines default to 'error' if no level detected
      if (!parsed.level || parsed.level === 'info') { (parsed as { level?: string }).level = 'error'; }
      this.emitLogEvent(parsed, rawLine);
    });

    this.child = spawn('docker', ['logs', '--follow', '--tail', '0', containerId], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child.stdout?.setEncoding((config.encoding ?? 'utf-8') as BufferEncoding);
    this.child.stderr?.setEncoding((config.encoding ?? 'utf-8') as BufferEncoding);

    this.child.stdout?.on('data', (chunk: string) => {
      this.processStream(chunk, 'stdout');
    });

    this.child.stderr?.on('data', (chunk: string) => {
      this.processStream(chunk, 'stderr');
    });

    this.child.on('close', () => {
      this.stdoutParser?.flush();
      this.stderrParser?.flush();
      this.connected = false;
    });

    this.child.on('error', () => {
      this.connected = false;
    });

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
    this.stdoutParser?.flush();
    this.stderrParser?.flush();
    this.stdoutParser = null;
    this.stderrParser = null;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.connected = false;
    this.handlers = [];
    this.config = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getSourceInfo(): LogSourceInfo {
    return this.config?.source ?? { type: 'docker', name: 'unknown' };
  }

  onLog(handler: (event: LogEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler);
    };
  }

  // ---- Internals ----

  private processStream(data: string, stream: 'stdout' | 'stderr'): void {
    const buffer = stream === 'stdout' ? 'stdoutBuffer' : 'stderrBuffer';
    const parser = stream === 'stdout' ? this.stdoutParser! : this.stderrParser!;

    const combined = this[buffer] + data;
    const lines = combined.split('\n');
    this[buffer] = lines.pop() ?? '';

    for (const line of lines) {
      if (line.length === 0) continue;
      const stripped = this.stripDockerPrefix(line);
      parser.feedLine(stripped);
    }
  }

  /** Strip Docker log prefix timestamp if present */
  private stripDockerPrefix(line: string): string {
    const m = DOCKER_PREFIX_PATTERN.exec(line);
    return m ? m[3]! : line;
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

  private validateContainer(containerId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = spawn('docker', ['inspect', '--format', '{{.State.Running}}', containerId], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      check.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      check.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Docker container '${containerId}' not found or not accessible: ${stderr.trim()}`));
        } else {
          resolve();
        }
      });
      check.on('error', (err) => {
        reject(new Error(`Failed to validate Docker container: ${err.message}`));
      });
    });
  }
}
