// ============================================================
// NetworkCapturePort — Abstraction for HTTP traffic capture
// Adapters: HTTP proxy, Express middleware, Browser CDP
// ============================================================

import type { NetworkConfig, RequestEvent, ResponseEvent } from '../types/index.js';

export abstract class NetworkCapturePort {
  // ---- Lifecycle ----
  abstract start(config: NetworkConfig): Promise<void>;
  abstract stop(): Promise<void>;
  abstract isCapturing(): boolean;

  // ---- Session ----
  abstract setSessionId(id: string): void;

  // ---- Event subscription ----
  abstract onRequest(handler: (event: RequestEvent) => void): () => void;
  abstract onResponse(handler: (event: ResponseEvent) => void): () => void;
}
