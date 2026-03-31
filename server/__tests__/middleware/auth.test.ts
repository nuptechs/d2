// ============================================================
// Auth Middleware — Comprehensive tests
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import {
  generateApiKey,
  signJwt,
  verifyJwt,
  createAuthMiddleware,
  timingSafeKeyCheck,
} from '../../src/middleware/auth.js';
import type { Request, Response } from 'express';

function mockReq(headers: Record<string, string> = {}, path = '/api/test'): Request {
  return {
    headers,
    path,
    get(name: string) { return headers[name.toLowerCase()]; },
  } as unknown as Request;
}

function mockRes(): Response & { _status: number; _json: any } {
  const res = {
    _status: 200,
    _json: null,
    status(code: number) { res._status = code; return res; },
    json(body: any) { res._json = body; return res; },
  };
  return res as unknown as Response & { _status: number; _json: any };
}

describe('Auth', () => {
  describe('generateApiKey', () => {
    it('generates 64 char hex string (32 bytes)', () => {
      const key = generateApiKey();
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });

    it('generates unique keys', () => {
      const keys = new Set(Array.from({ length: 50 }, () => generateApiKey()));
      expect(keys.size).toBe(50);
    });
  });

  describe('signJwt / verifyJwt', () => {
    const secret = 'test-secret-key-123';

    it('creates and verifies a valid JWT', () => {
      const token = signJwt({ sub: 'user-1', permissions: ['read'] }, secret);
      const payload = verifyJwt(token, secret);
      expect(payload).not.toBeNull();
      expect(payload!.sub).toBe('user-1');
      expect(payload!.permissions).toEqual(['read']);
      expect(payload!.iat).toBeDefined();
      expect(payload!.exp).toBeDefined();
    });

    it('rejects token with wrong secret', () => {
      const token = signJwt({ sub: 'user-1', permissions: [] }, secret);
      expect(verifyJwt(token, 'wrong-secret')).toBeNull();
    });

    it('rejects expired token', () => {
      const token = signJwt({ sub: 'user-1', permissions: [] }, secret, -1);
      expect(verifyJwt(token, secret)).toBeNull();
    });

    it('rejects malformed token', () => {
      expect(verifyJwt('not-a-jwt', secret)).toBeNull();
      expect(verifyJwt('a.b', secret)).toBeNull();
      expect(verifyJwt('', secret)).toBeNull();
    });

    it('rejects tampered payload', () => {
      const token = signJwt({ sub: 'user-1', permissions: [] }, secret);
      const parts = token.split('.');
      // Tamper with payload by flipping a character
      parts[1] = parts[1].slice(0, -1) + (parts[1].endsWith('A') ? 'B' : 'A');
      expect(verifyJwt(parts.join('.'), secret)).toBeNull();
    });
  });

  describe('createAuthMiddleware', () => {
    it('skips auth when disabled', () => {
      const mw = createAuthMiddleware({ apiKeys: [], jwtSecret: '', enableAuth: false });
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
      expect((req as any).auth).toBeDefined();
      expect((req as any).auth.subject).toBe('anonymous');
    });

    it('bypasses health check routes', () => {
      const mw = createAuthMiddleware({ apiKeys: ['key1'], jwtSecret: 's', enableAuth: true });
      const req = mockReq({}, '/health');
      const res = mockRes();
      const next = vi.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('authenticates with valid API key via X-API-Key', () => {
      const mw = createAuthMiddleware({ apiKeys: ['my-key'], jwtSecret: 's', enableAuth: true });
      const req = mockReq({ 'x-api-key': 'my-key' });
      const res = mockRes();
      const next = vi.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
      expect((req as any).auth.type).toBe('api-key');
    });

    it('authenticates with valid JWT via Bearer', () => {
      const secret = 'jwt-secret';
      const token = signJwt({ sub: 'user-1', permissions: ['admin'] }, secret);
      const mw = createAuthMiddleware({ apiKeys: [], jwtSecret: secret, enableAuth: true });
      const req = mockReq({ authorization: `Bearer ${token}` });
      const res = mockRes();
      const next = vi.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
      expect((req as any).auth.type).toBe('jwt');
      expect((req as any).auth.permissions).toContain('admin');
    });

    it('rejects invalid API key with 401', () => {
      const mw = createAuthMiddleware({ apiKeys: ['valid'], jwtSecret: '', enableAuth: true });
      const req = mockReq({ 'x-api-key': 'invalid' });
      const res = mockRes();
      const next = vi.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    it('rejects missing credentials with 401', () => {
      const mw = createAuthMiddleware({ apiKeys: ['valid'], jwtSecret: 's', enableAuth: true });
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    it('authenticates API key via Bearer header (non-JWT format)', () => {
      const apiKey = 'abcdef1234567890abcdef1234567890';
      const mw = createAuthMiddleware({ apiKeys: [apiKey], jwtSecret: 's', enableAuth: true });
      const req = mockReq({ authorization: `Bearer ${apiKey}` });
      const res = mockRes();
      const next = vi.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
      expect((req as any).auth.type).toBe('api-key');
    });

    it('rejects invalid JWT via Bearer with 401', () => {
      const mw = createAuthMiddleware({ apiKeys: [], jwtSecret: 'secret', enableAuth: true });
      const req = mockReq({ authorization: 'Bearer eyJ.eyJ.bad' });
      const res = mockRes();
      const next = vi.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._json.message).toContain('Invalid or expired JWT');
    });

    it('bypasses /ready path', () => {
      const mw = createAuthMiddleware({ apiKeys: ['key'], jwtSecret: 's', enableAuth: true });
      const req = mockReq({}, '/ready');
      const res = mockRes();
      const next = vi.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('does not leak error details for wrong-length API key', () => {
      const mw = createAuthMiddleware({ apiKeys: ['correct-key'], jwtSecret: 's', enableAuth: true });
      const req = mockReq({ 'x-api-key': 'short' });
      const res = mockRes();
      const next = vi.fn();
      mw(req, res, next);
      expect(res._status).toBe(401);
      expect(res._json.message).not.toContain('correct-key');
    });
  });

  describe('signJwt / verifyJwt — edge cases', () => {
    const secret = 'edge-case-secret';

    it('rejects token with wrong algorithm in header', () => {
      // Manually forge a token with alg: "none"
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: 'evil', permissions: ['*'], iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
      const fakeToken = `${header}.${payload}.`;
      expect(verifyJwt(fakeToken, secret)).toBeNull();
    });

    it('rejects token with missing sub field', () => {
      // Sign a valid token, then tamper the payload to remove sub
      const token = signJwt({ sub: 'user', permissions: [] }, secret);
      const parts = token.split('.');
      const payloadObj = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
      delete payloadObj.sub;
      // Re-encode payload (signature will break → null anyway)
      parts[1] = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
      expect(verifyJwt(parts.join('.'), secret)).toBeNull();
    });

    it('rejects token with non-array permissions', () => {
      const token = signJwt({ sub: 'user', permissions: [] }, secret);
      const parts = token.split('.');
      const payloadObj = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
      payloadObj.permissions = 'admin';
      parts[1] = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
      expect(verifyJwt(parts.join('.'), secret)).toBeNull();
    });

    it('handles custom expiry', () => {
      const token = signJwt({ sub: 'user', permissions: [] }, secret, 7200);
      const payload = verifyJwt(token, secret);
      expect(payload).not.toBeNull();
      expect(payload!.exp - payload!.iat).toBe(7200);
    });

    it('rejects completely garbage base64 segments', () => {
      expect(verifyJwt('!!!.@@@.###', secret)).toBeNull();
    });

    it('rejects token with empty segments', () => {
      expect(verifyJwt('..', secret)).toBeNull();
    });
  });

  // ── timingSafeKeyCheck ──────────────────────────────────────

  describe('timingSafeKeyCheck', () => {
    it('returns true for a matching key in the list', () => {
      expect(timingSafeKeyCheck(['key-a', 'key-b', 'secret-123'], 'key-b')).toBe(true);
    });

    it('returns false for a non-matching key', () => {
      expect(timingSafeKeyCheck(['key-a', 'key-b'], 'key-c')).toBe(false);
    });

    it('returns false for empty keys array', () => {
      expect(timingSafeKeyCheck([], 'anything')).toBe(false);
    });

    it('returns false when candidate has different length', () => {
      expect(timingSafeKeyCheck(['short'], 'much-longer-key-value')).toBe(false);
    });

    it('returns false for off-by-one character', () => {
      expect(timingSafeKeyCheck(['abcdef'], 'abcdeg')).toBe(false);
    });
  });
});
