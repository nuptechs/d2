// ============================================================
// Authentication middleware — API Key + JWT (node:crypto only)
// ============================================================

import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

// ── Types ────────────────────────────────────────────────────

export interface AuthConfig {
  apiKeys: string[];
  jwtSecret: string;
  enableAuth: boolean;
}

export interface JwtPayload {
  sub: string;
  permissions: string[];
  iat: number;
  exp: number;
}

export interface AuthInfo {
  type: 'api-key' | 'jwt';
  subject: string;
  permissions: string[];
}

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      auth?: AuthInfo;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────

const HEALTH_PATHS = new Set(['/health', '/ready']);

/** Timing-safe comparison for API keys — avoids side-channel leakage */
export function timingSafeKeyCheck(keys: string[], candidate: string): boolean {
  let match = false;
  for (const key of keys) {
    if (key.length === candidate.length) {
      const a = Buffer.from(key, 'utf-8');
      const b = Buffer.from(candidate, 'utf-8');
      if (timingSafeEqual(a, b)) match = true;
      // Don't short-circuit — check all keys for constant time
    }
  }
  return match;
}

function base64UrlEncode(data: Buffer): string {
  return data.toString('base64url');
}

function base64UrlDecode(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

function hmacSign(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

function isJwtFormat(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

// ── Public: generate API key ─────────────────────────────────

export function generateApiKey(): string {
  return randomBytes(32).toString('hex');
}

// ── Public: sign JWT (HMAC-SHA256) ───────────────────────────

export function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  secret: string,
  expiresIn: number = 3600,
): string {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'HS256', typ: 'JWT' };
  const fullPayload: JwtPayload = {
    ...payload,
    iat: now,
    exp: now + expiresIn,
  };

  const segments = [
    base64UrlEncode(Buffer.from(JSON.stringify(header))),
    base64UrlEncode(Buffer.from(JSON.stringify(fullPayload))),
  ];

  const signingInput = segments.join('.');
  const signature = base64UrlEncode(hmacSign(signingInput, secret));

  return `${signingInput}.${signature}`;
}

// ── Public: verify JWT ───────────────────────────────────────

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const headerB64 = parts[0]!;
    const payloadB64 = parts[1]!;
    const signatureB64 = parts[2]!;
    const signingInput = `${headerB64}.${payloadB64}`;

    // Verify signature with timing-safe comparison
    const expected = hmacSign(signingInput, secret);
    const actual = base64UrlDecode(signatureB64);

    if (expected.length !== actual.length) return null;
    if (!timingSafeEqual(expected, actual)) return null;

    // Decode and validate header
    const header = JSON.parse(base64UrlDecode(headerB64).toString('utf-8'));
    if (header.alg !== 'HS256') return null;

    // Decode payload
    const payload: JwtPayload = JSON.parse(
      base64UrlDecode(payloadB64).toString('utf-8'),
    );

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null;

    // Validate required fields
    if (typeof payload.sub !== 'string' || !Array.isArray(payload.permissions)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

// ── Public: middleware factory ────────────────────────────────

export function createAuthMiddleware(config: AuthConfig): RequestHandler {
  // Keep array for timing-safe iteration
  const validKeysList = [...config.apiKeys];

  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip auth in dev mode
    if (!config.enableAuth) {
      req.auth = { type: 'api-key', subject: 'anonymous', permissions: ['*'] };
      next();
      return;
    }

    // Health check bypass
    if (HEALTH_PATHS.has(req.path)) {
      next();
      return;
    }

    // Extract token from headers
    const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
    const authzHeader = req.headers['authorization'] as string | undefined;

    // 1) Check X-API-Key header first
    if (apiKeyHeader) {
      if (timingSafeKeyCheck(validKeysList, apiKeyHeader)) {
        req.auth = { type: 'api-key', subject: 'sdk-client', permissions: ['*'] };
        next();
        return;
      }
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid API key' });
      return;
    }

    // 2) Check Authorization: Bearer <token>
    if (authzHeader?.startsWith('Bearer ')) {
      const token = authzHeader.slice(7);

      // Detect JWT (three dot-separated parts) vs API key
      if (isJwtFormat(token)) {
        const payload = verifyJwt(token, config.jwtSecret);
        if (payload) {
          req.auth = {
            type: 'jwt',
            subject: payload.sub,
            permissions: payload.permissions,
          };
          next();
          return;
        }
        res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired JWT' });
        return;
      }

      // Treat as API key
      if (timingSafeKeyCheck(validKeysList, token)) {
        req.auth = { type: 'api-key', subject: 'sdk-client', permissions: ['*'] };
        next();
        return;
      }
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid API key' });
      return;
    }

    // No credentials provided
    res.status(401).json({ error: 'Unauthorized', message: 'Missing authentication credentials' });
  };
}
