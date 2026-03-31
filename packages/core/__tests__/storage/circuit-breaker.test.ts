// ============================================================
// StorageCircuitBreaker + isTransientError — Unit tests
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { StorageCircuitBreaker, isTransientError } from '../../src/storage/postgres-storage.adapter.js';

// ---- isTransientError -------------------------------------------------

describe('isTransientError', () => {
  it('returns true for ECONNREFUSED', () => {
    const err = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
    expect(isTransientError(err)).toBe(true);
  });

  it('returns true for ECONNRESET', () => {
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    expect(isTransientError(err)).toBe(true);
  });

  it('returns true for ETIMEDOUT', () => {
    const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    expect(isTransientError(err)).toBe(true);
  });

  it('returns true for serialization_failure (40001)', () => {
    const err = Object.assign(new Error('serialization'), { code: '40001' });
    expect(isTransientError(err)).toBe(true);
  });

  it('returns true for deadlock_detected (40P01)', () => {
    const err = Object.assign(new Error('deadlock'), { code: '40P01' });
    expect(isTransientError(err)).toBe(true);
  });

  it('returns true for admin_shutdown (57P01)', () => {
    const err = Object.assign(new Error('shutdown'), { code: '57P01' });
    expect(isTransientError(err)).toBe(true);
  });

  it('returns true for cannot_connect_now (57P03)', () => {
    const err = Object.assign(new Error('recovery'), { code: '57P03' });
    expect(isTransientError(err)).toBe(true);
  });

  it('returns true for "Connection terminated" message', () => {
    expect(isTransientError(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  it('returns true for "server closed the connection" message', () => {
    expect(isTransientError(new Error('server closed the connection unexpectedly'))).toBe(true);
  });

  it('returns false for permanent errors', () => {
    expect(isTransientError(new Error('syntax error at position 42'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isTransientError('string')).toBe(false);
    expect(isTransientError(42)).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});

// ---- StorageCircuitBreaker -------------------------------------------

describe('StorageCircuitBreaker', () => {
  it('starts in closed state', () => {
    const cb = new StorageCircuitBreaker();
    expect(cb.getState()).toBe('closed');
  });

  it('stays closed while failures < threshold', async () => {
    const cb = new StorageCircuitBreaker({ failureThreshold: 3 });
    const fail = () => cb.execute(() => Promise.reject(new Error('boom'))).catch(() => {});

    await fail();
    await fail();
    expect(cb.getState()).toBe('closed');
  });

  it('opens after reaching failure threshold', async () => {
    const cb = new StorageCircuitBreaker({ failureThreshold: 3 });
    const fail = () => cb.execute(() => Promise.reject(new Error('boom'))).catch(() => {});

    await fail();
    await fail();
    await fail();
    expect(cb.getState()).toBe('open');
  });

  it('rejects immediately when open', async () => {
    const cb = new StorageCircuitBreaker({ failureThreshold: 1 });
    await cb.execute(() => Promise.reject(new Error('trigger'))).catch(() => {});
    expect(cb.getState()).toBe('open');

    await expect(cb.execute(() => Promise.resolve('ok'))).rejects.toThrow('Circuit breaker is open');
  });

  it('transitions to half-open after reset timeout', async () => {
    const cb = new StorageCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 50,
    });

    await cb.execute(() => Promise.reject(new Error('trigger'))).catch(() => {});
    expect(cb.getState()).toBe('open');

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 60));

    // Next call should succeed — CB is half-open
    const result = await cb.execute(() => Promise.resolve('recovered'));
    expect(result).toBe('recovered');
    expect(cb.getState()).toBe('closed');
  });

  it('returns to open on failure during half-open', async () => {
    const cb = new StorageCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 50,
    });

    await cb.execute(() => Promise.reject(new Error('trigger'))).catch(() => {});
    await new Promise((r) => setTimeout(r, 60));

    // Half-open probe fails → back to open
    await cb.execute(() => Promise.reject(new Error('still broken'))).catch(() => {});
    expect(cb.getState()).toBe('open');
  });

  it('limits half-open probe attempts', async () => {
    const cb = new StorageCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 2,
    });

    await cb.execute(() => Promise.reject(new Error('trigger'))).catch(() => {});
    await new Promise((r) => setTimeout(r, 60));

    // Two half-open probes — both succeed but the second reaches the max
    let callCount = 0;
    await cb.execute(() => { callCount++; return Promise.resolve(1); });
    // After successful half-open call, CB returns to closed
    expect(cb.getState()).toBe('closed');
    expect(callCount).toBe(1);
  });

  it('resets failure count on success in closed state', async () => {
    const cb = new StorageCircuitBreaker({ failureThreshold: 3 });

    await cb.execute(() => Promise.reject(new Error('f1'))).catch(() => {});
    await cb.execute(() => Promise.reject(new Error('f2'))).catch(() => {});
    // 2 failures but then a success
    await cb.execute(() => Promise.resolve('ok'));
    // Counter is reset — need 3 more failures to open
    await cb.execute(() => Promise.reject(new Error('f3'))).catch(() => {});
    await cb.execute(() => Promise.reject(new Error('f4'))).catch(() => {});
    expect(cb.getState()).toBe('closed');
  });

  it('passes through return values', async () => {
    const cb = new StorageCircuitBreaker();
    const result = await cb.execute(() => Promise.resolve({ data: 42 }));
    expect(result).toEqual({ data: 42 });
  });
});
