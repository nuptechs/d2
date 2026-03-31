// ============================================================
// Error Boundary — Tests for uncaught errors, unhandled
// rejections, deduplication, and cleanup
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installErrorBoundary } from '../../src/browser/error-boundary.js';

// Minimal window mock for Node.js environment
const listeners: Record<string, Function[]> = {};

const mockWindow = {
  addEventListener: vi.fn((event: string, handler: Function) => {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(handler);
  }),
  removeEventListener: vi.fn((event: string, handler: Function) => {
    if (listeners[event]) {
      listeners[event] = listeners[event].filter(h => h !== handler);
    }
  }),
};

function dispatchError(message: string, error?: Error): void {
  const event = {
    error: error ?? new Error(message),
    message,
    filename: 'test.js',
    lineno: 42,
    colno: 10,
  };
  for (const handler of listeners['error'] ?? []) {
    handler(event);
  }
}

function dispatchRejection(reason: unknown): void {
  const event = { reason };
  for (const handler of listeners['unhandledrejection'] ?? []) {
    handler(event);
  }
}

// Install window mock
const originalWindow = globalThis.window;

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(listeners).forEach((k) => delete listeners[k]);
  (globalThis as any).window = mockWindow;
});

afterEach(() => {
  (globalThis as any).window = originalWindow;
});

describe('installErrorBoundary', () => {
  it('registers error and unhandledrejection listeners', () => {
    const cleanup = installErrorBoundary(() => {});
    expect(mockWindow.addEventListener).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mockWindow.addEventListener).toHaveBeenCalledWith('unhandledrejection', expect.any(Function));
    cleanup();
  });

  it('captures uncaught errors', () => {
    const events: any[] = [];
    const cleanup = installErrorBoundary((e) => events.push(e));

    dispatchError('Something broke', new Error('Something broke'));

    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('sdk');
    expect(events[0].type).toBe('custom');
    expect(events[0].name).toBe('uncaught-error');
    expect(events[0].data.message).toBe('Something broke');
    expect(events[0].data.errorType).toBe('uncaught');
    expect(events[0].data.fileName).toBe('test.js');
    expect(events[0].data.lineNumber).toBe(42);
    expect(events[0].data.columnNumber).toBe(10);

    cleanup();
  });

  it('captures error stack when available', () => {
    const events: any[] = [];
    const cleanup = installErrorBoundary((e) => events.push(e));

    const err = new Error('With stack');
    dispatchError('With stack', err);

    expect(events[0].data.stack).toBeDefined();
    expect(events[0].data.stack).toContain('With stack');

    cleanup();
  });

  it('handles error events without Error object', () => {
    const events: any[] = [];
    const cleanup = installErrorBoundary((e) => events.push(e));

    // Dispatch with no error object
    const event = {
      error: null,
      message: 'Script error.',
      filename: undefined,
      lineno: 0,
      colno: 0,
    };
    for (const handler of listeners['error'] ?? []) {
      handler(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].data.message).toBe('Script error.');

    cleanup();
  });

  it('captures unhandled promise rejections with Error', () => {
    const events: any[] = [];
    const cleanup = installErrorBoundary((e) => events.push(e));

    dispatchRejection(new Error('Promise failed'));

    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('unhandled-rejection');
    expect(events[0].data.errorType).toBe('unhandled-rejection');
    expect(events[0].data.message).toBe('Promise failed');
    expect(events[0].data.stack).toBeDefined();

    cleanup();
  });

  it('captures unhandled promise rejections with string', () => {
    const events: any[] = [];
    const cleanup = installErrorBoundary((e) => events.push(e));

    dispatchRejection('string reason');

    expect(events).toHaveLength(1);
    expect(events[0].data.message).toBe('string reason');

    cleanup();
  });

  it('captures non-Error/non-string rejection reasons', () => {
    const events: any[] = [];
    const cleanup = installErrorBoundary((e) => events.push(e));

    dispatchRejection(42);

    expect(events).toHaveLength(1);
    expect(events[0].data.message).toBe('Unhandled promise rejection');

    cleanup();
  });

  it('deduplicates identical errors within 1s window', () => {
    const events: any[] = [];
    const cleanup = installErrorBoundary((e) => events.push(e));

    dispatchError('Same error');
    dispatchError('Same error');
    dispatchError('Same error');

    expect(events).toHaveLength(1);

    cleanup();
  });

  it('allows same error after dedup window expires', async () => {
    const events: any[] = [];
    const realDateNow = Date.now;
    let fakeTime = 1000;
    Date.now = () => fakeTime;

    const cleanup = installErrorBoundary((e) => events.push(e));

    dispatchError('Timed error');
    expect(events).toHaveLength(1);

    // Advance past dedup window (1000ms)
    fakeTime += 1100;

    dispatchError('Timed error');
    expect(events).toHaveLength(2);

    Date.now = realDateNow;
    cleanup();
  });

  it('caps dedup entries to prevent unbounded growth', () => {
    const events: any[] = [];
    const cleanup = installErrorBoundary((e) => events.push(e));

    // Fire 600 unique errors — should not crash (MAX_DEDUP_ENTRIES = 500)
    for (let i = 0; i < 600; i++) {
      dispatchError(`Unique error ${i}`, new Error(`Unique error ${i}`));
    }

    // All 600 unique errors should be emitted
    expect(events).toHaveLength(600);

    cleanup();
  });

  it('cleanup removes listeners and clears state', () => {
    const events: any[] = [];
    const cleanup = installErrorBoundary((e) => events.push(e));

    cleanup();

    expect(mockWindow.removeEventListener).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mockWindow.removeEventListener).toHaveBeenCalledWith('unhandledrejection', expect.any(Function));

    // Events after cleanup should not be captured
    dispatchError('After cleanup');
    expect(events).toHaveLength(0);
  });
});
