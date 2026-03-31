import { describe, it, expect } from 'vitest';
import { isSensitiveKey, redactHeaders, redactBody, maskValue } from '../../src/utils/redact.js';

describe('isSensitiveKey', () => {
  it('matches known sensitive keys case-insensitively', () => {
    expect(isSensitiveKey('password')).toBe(true);
    expect(isSensitiveKey('Authorization')).toBe(true);
    expect(isSensitiveKey('API_KEY')).toBe(true);
    expect(isSensitiveKey('cookie')).toBe(true);
    expect(isSensitiveKey('ssn')).toBe(true);
  });

  it('returns false for non-sensitive keys', () => {
    expect(isSensitiveKey('username')).toBe(false);
    expect(isSensitiveKey('email')).toBe(false);
    expect(isSensitiveKey('Content-Type')).toBe(false);
  });

  it('normalizes dashes and underscores (api-key matches api_key)', () => {
    expect(isSensitiveKey('api-key')).toBe(true);
    expect(isSensitiveKey('access-token')).toBe(true);
    expect(isSensitiveKey('refresh_token')).toBe(true);
  });

  it('matches custom additionalKeys', () => {
    expect(isSensitiveKey('x-custom-secret', ['x-custom-secret'])).toBe(true);
    expect(isSensitiveKey('x-custom-secret')).toBe(false);
  });
});

describe('redactHeaders', () => {
  it('replaces sensitive header values with [REDACTED]', () => {
    const headers = {
      'Authorization': 'Bearer abc123',
      'Content-Type': 'application/json',
      'Cookie': 'session=xyz',
    };
    const result = redactHeaders(headers);
    expect(result['Authorization']).toBe('[REDACTED]');
    expect(result['Cookie']).toBe('[REDACTED]');
    expect(result['Content-Type']).toBe('application/json');
  });

  it('handles empty header map', () => {
    expect(redactHeaders({})).toEqual({});
  });

  it('preserves non-sensitive headers unchanged', () => {
    const headers = { 'Accept': 'text/html', 'X-Request-Id': '123' };
    const result = redactHeaders(headers);
    expect(result).toEqual(headers);
  });
});

describe('redactBody', () => {
  it('redacts JWT tokens', () => {
    const body = '{"token": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"}';
    const result = redactBody(body);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('redacts Bearer tokens', () => {
    const body = 'Authorization: Bearer abc123def456';
    const result = redactBody(body);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('abc123def456');
  });

  it('redacts credit card numbers', () => {
    const body = 'card: 4111-1111-1111-1111';
    const result = redactBody(body);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('4111-1111-1111-1111');
  });

  it('redacts SSN patterns', () => {
    const body = 'ssn: 123-45-6789';
    const result = redactBody(body);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('123-45-6789');
  });

  it('redacts JSON fields by key', () => {
    const body = '{"password": "mysecret", "username": "john"}';
    const result = redactBody(body);
    expect(result).toContain('"[REDACTED]"');
    expect(result).toContain('"john"');
    expect(result).not.toContain('"mysecret"');
  });

  it('handles custom sensitiveFields', () => {
    const body = '{"myCustomField": "secret_value", "public": "ok"}';
    const result = redactBody(body, ['myCustomField']);
    expect(result).toContain('"[REDACTED]"');
    expect(result).toContain('"ok"');
  });

  it('returns empty string for empty input', () => {
    expect(redactBody('')).toBe('');
  });

  it('does not corrupt non-sensitive JSON fields', () => {
    const body = '{"username": "john", "email": "john@example.com", "age": 30}';
    const result = redactBody(body);
    expect(result).toBe(body);
  });

  it('produces identical results on consecutive calls (regex lastIndex reset)', () => {
    const body = 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig end';
    const result1 = redactBody(body);
    const result2 = redactBody(body);
    const result3 = redactBody(body);
    expect(result1).toBe(result2);
    expect(result2).toBe(result3);
    expect(result1).toContain('[REDACTED]');
  });
});

describe('maskValue', () => {
  it('shows first/last N chars with asterisks in between', () => {
    const result = maskValue('1234567890', 4);
    expect(result).toBe('1234****7890');
  });

  it('fully masks short values', () => {
    const result = maskValue('abc', 4);
    expect(result).toBe('***');
  });

  it('uses minimum 4 asterisks in the middle', () => {
    const result = maskValue('123456789', 4);
    expect(result.startsWith('1234')).toBe(true);
    expect(result.endsWith('6789')).toBe(true);
    expect(result).toContain('****');
  });
});
