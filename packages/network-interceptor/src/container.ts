// ============================================================
// Container — Factory for NetworkCapturePort adapters
// ============================================================

import type { NetworkConfig } from '@probe/core';
import { NetworkCapturePort } from '@probe/core';
import { ProxyAdapter } from './adapters/proxy.adapter.js';
import { MiddlewareAdapter } from './adapters/middleware.adapter.js';

/**
 * Create the appropriate NetworkCapturePort adapter based on config.mode.
 * - 'proxy'      → local HTTP proxy server
 * - 'middleware'  → Express-compatible middleware
 * - 'browser'    → handled by @probe/browser-agent (not this package)
 */
export function createNetworkCapture(config: NetworkConfig): NetworkCapturePort {
  switch (config.mode) {
    case 'proxy':
      return new ProxyAdapter();
    case 'middleware':
      return new MiddlewareAdapter();
    case 'browser':
      throw new Error(
        `NetworkConfig mode 'browser' is handled by @probe/browser-agent, not @probe/network-interceptor.`,
      );
    default:
      throw new Error(`Unknown network capture mode: ${String((config as NetworkConfig).mode)}`);
  }
}
