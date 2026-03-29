// ============================================================
// LogSourcePort — Abstraction for log source connections
// Adapters: File tail, Docker logs, stdout/stderr pipe
// ============================================================

import type { LogCollectorConfig, LogEvent, LogSourceInfo } from '../types/index.js';

export abstract class LogSourcePort {
  // ---- Lifecycle ----
  abstract connect(config: LogCollectorConfig): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract isConnected(): boolean;

  // ---- Info ----
  abstract getSourceInfo(): LogSourceInfo;

  // ---- Event subscription ----
  abstract onLog(handler: (event: LogEvent) => void): () => void;
}
