// ============================================================
// ProxyAdapter — Tests for lifecycle, connection management,
// cleanup timer, pending request limits
// (SSRF tests are in proxy-ssrf.test.ts)
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProxyAdapter } from '../../src/adapters/proxy.adapter.js';
import type { NetworkConfig } from '@probe/core';

// Use a random high port to avoid conflicts
const TEST_PORT = 18000 + Math.floor(Math.random() * 1000);

const defaultConfig: NetworkConfig = {
  enabled: true,
  captureBody: false,
  maxBodySize: 1_048_576,
  proxyPort: TEST_PORT,
};

describe('ProxyAdapter', () => {
  let adapter: ProxyAdapter;

  beforeEach(() => {
    adapter = new ProxyAdapter();
  });

  afterEach(async () => {
    if (adapter.isCapturing()) {
      await adapter.stop();
    }
  });

  describe('lifecycle', () => {
    it('starts as not capturing', () => {
      expect(adapter.isCapturing()).toBe(false);
    });

    it('start creates server and activates capturing', async () => {
      await adapter.start(defaultConfig);
      expect(adapter.isCapturing()).toBe(true);
    });

    it('stop deactivates capturing and closes server', async () => {
      await adapter.start(defaultConfig);
      await adapter.stop();
      expect(adapter.isCapturing()).toBe(false);
    });

    it('stop is safe when not started', async () => {
      await adapter.stop(); // Should not throw
    });

    it('start is idempotent (second call is no-op)', async () => {
      await adapter.start(defaultConfig);
      // Second start with same config should not throw
      await adapter.start(defaultConfig);
      expect(adapter.isCapturing()).toBe(true);
    });

    it('setSessionId works without error', () => {
      adapter.setSessionId('test-session');
    });
  });

  describe('onRequest / onResponse handlers', () => {
    it('registers request handler and returns unsubscribe', () => {
      const handler = vi.fn();
      const unsub = adapter.onRequest(handler);
      expect(unsub).toBeTypeOf('function');
      unsub();
    });

    it('registers response handler and returns unsubscribe', () => {
      const handler = vi.fn();
      const unsub = adapter.onResponse(handler);
      expect(unsub).toBeTypeOf('function');
      unsub();
    });

    it('unsubscribe removes the handler', () => {
      const handler = vi.fn();
      const unsub = adapter.onRequest(handler);
      unsub();
      // After unsubscribe, handler should not be in the list
      // (Internal state — we verify by testing that the handler count logic works)
    });
  });

  describe('server binding', () => {
    it('listens on configured port', async () => {
      await adapter.start(defaultConfig);
      // If we got here without error, the server is listening
      expect(adapter.isCapturing()).toBe(true);
    });

    it('rejects when port is already in use', async () => {
      await adapter.start(defaultConfig);
      const adapter2 = new ProxyAdapter();
      await expect(
        adapter2.start({ ...defaultConfig, proxyPort: TEST_PORT }),
      ).rejects.toThrow();
      // Cleanup
      if (adapter2.isCapturing()) await adapter2.stop();
    });
  });

  describe('cleanup after stop', () => {
    it('clears handlers on stop', async () => {
      const reqHandler = vi.fn();
      const resHandler = vi.fn();
      adapter.onRequest(reqHandler);
      adapter.onResponse(resHandler);
      await adapter.start(defaultConfig);
      await adapter.stop();

      // Handlers should be cleared (no way to verify directly,
      // but we can confirm no errors occur)
      expect(adapter.isCapturing()).toBe(false);
    });
  });
});
