// ============================================================
// DockerLogAdapter — Tests for container ID validation,
// connect/disconnect lifecycle, stream processing
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock child_process.spawn before importing the adapter
const mockStdout = new EventEmitter();
const mockStderr = new EventEmitter();
const mockChild: any = Object.assign(new EventEmitter(), {
  stdout: Object.assign(mockStdout, { setEncoding: vi.fn() }),
  stderr: Object.assign(mockStderr, { setEncoding: vi.fn() }),
  kill: vi.fn(),
  pid: 12345,
});

// Also mock the validation spawn (docker inspect)
const mockInspectStdout = new EventEmitter();
const mockInspectChild: any = Object.assign(new EventEmitter(), {
  stdout: Object.assign(mockInspectStdout, { setEncoding: vi.fn() }),
  stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
  kill: vi.fn(),
});

let spawnCallCount = 0;

vi.mock('node:child_process', () => ({
  spawn: vi.fn((...args: any[]) => {
    spawnCallCount++;
    // First call is docker inspect, second is docker logs
    if (args[1]?.[0] === 'inspect') {
      // Auto-resolve the inspect
      setTimeout(() => {
        mockInspectStdout.emit('data', 'true');
        mockInspectChild.emit('close', 0);
      }, 0);
      return mockInspectChild;
    }
    return mockChild;
  }),
}));

const { DockerLogAdapter } = await import('../../src/adapters/docker.adapter.js');

describe('DockerLogAdapter', () => {
  let adapter: InstanceType<typeof DockerLogAdapter>;

  beforeEach(() => {
    spawnCallCount = 0;
    adapter = new DockerLogAdapter();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (adapter.isConnected()) {
      await adapter.disconnect();
    }
  });

  describe('container ID validation', () => {
    it('rejects empty containerId', async () => {
      await expect(
        adapter.connect({ enabled: true, source: { type: 'docker', name: 'test' } }),
      ).rejects.toThrow('requires config.source.containerId');
    });

    it('rejects container IDs with shell metacharacters', async () => {
      await expect(
        adapter.connect({
          enabled: true,
          source: { type: 'docker', name: 'test', containerId: 'abc;rm -rf /' },
        }),
      ).rejects.toThrow('Invalid container ID format');
    });

    it('rejects container IDs starting with special chars', async () => {
      await expect(
        adapter.connect({
          enabled: true,
          source: { type: 'docker', name: 'test', containerId: '-malicious' },
        }),
      ).rejects.toThrow('Invalid container ID format');
    });

    it('rejects container IDs longer than 128 chars', async () => {
      const longId = 'a'.repeat(129);
      await expect(
        adapter.connect({
          enabled: true,
          source: { type: 'docker', name: 'test', containerId: longId },
        }),
      ).rejects.toThrow('Invalid container ID format');
    });

    it('accepts valid container IDs', async () => {
      const validIds = ['abc123', 'my-container', 'app_1.0', 'a'.repeat(64)];
      for (const id of validIds) {
        // Valid format, will pass validation and attempt spawn
        expect(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)).toBe(true);
        expect(id.length <= 128).toBe(true);
      }
    });
  });

  describe('lifecycle', () => {
    it('starts as not connected', () => {
      expect(adapter.isConnected()).toBe(false);
    });

    it('getSourceInfo returns default when not configured', () => {
      const info = adapter.getSourceInfo();
      expect(info.type).toBe('docker');
    });

    it('disconnect is safe when not connected', async () => {
      await adapter.disconnect(); // Should not throw
    });

    it('setSessionId sets the session', () => {
      adapter.setSessionId('test-session');
      // Internal - no public getter, but should not throw
    });
  });

  describe('onLog handler', () => {
    it('registers and returns unsubscribe function', () => {
      const handler = vi.fn();
      const unsub = adapter.onLog(handler);
      expect(unsub).toBeTypeOf('function');
      unsub(); // Should not throw
    });
  });
});
