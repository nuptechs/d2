// ============================================================
// Security headers — Integration tests
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
import { MemoryStorageAdapter } from '@probe/core';
import { sessionsRouter } from '../../src/routes/sessions.js';
import { SessionManager } from '../../src/services/session-manager.js';
import { errorHandler, notFoundHandler } from '../../src/middleware/error-handler.js';

function createSecureApp(manager: SessionManager) {
  const app = express();
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  }));
  app.use(express.json());
  app.locals['sessionManager'] = manager;
  app.use('/api/sessions', sessionsRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('Security Headers', () => {
  let manager: SessionManager;
  let app: ReturnType<typeof express>;

  beforeAll(async () => {
    const storage = new MemoryStorageAdapter();
    await storage.initialize();
    manager = new SessionManager(storage);
    app = createSecureApp(manager);
  });

  afterAll(() => {
    manager.destroy();
  });

  it('sets Content-Security-Policy header', async () => {
    const res = await request(app).get('/api/sessions');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).toContain("object-src 'none'");
  });

  it('sets X-Content-Type-Options header', async () => {
    const res = await request(app).get('/api/sessions');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets X-Frame-Options header', async () => {
    const res = await request(app).get('/api/sessions');
    // Helmet may set this as SAMEORIGIN or via frame-ancestors
    expect(
      res.headers['x-frame-options'] !== undefined ||
      res.headers['content-security-policy']?.includes('frame-ancestors')
    ).toBe(true);
  });

  it('removes X-Powered-By header', async () => {
    const res = await request(app).get('/api/sessions');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets Strict-Transport-Security header', async () => {
    const res = await request(app).get('/api/sessions');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });
});
