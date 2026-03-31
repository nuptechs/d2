// ============================================================
// @probe/server — Express + WebSocket server entry point
// ============================================================

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { sessionsRouter } from './routes/sessions.js';
import { eventsRouter } from './routes/events.js';
import { reportsRouter } from './routes/reports.js';
import { SessionManager } from './services/session-manager.js';
import { setupWebSocket } from './ws/realtime.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createRateLimiter } from './middleware/rate-limiter.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { logger } from './logger.js';
import { createStorage } from '@probe/core';
import type { StorageConfig } from '@probe/core';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = parseInt(process.env['PORT'] ?? '7070', 10);
const HOST = process.env['HOST'] ?? '0.0.0.0';

// ---- Storage initialization ----
function buildStorageConfig(): StorageConfig {
  const dbUrl = process.env['DATABASE_URL'];
  if (dbUrl) {
    return { type: 'postgres', connectionString: dbUrl };
  }
  const storageType = (process.env['STORAGE_TYPE'] ?? 'memory') as StorageConfig['type'];
  return {
    type: storageType,
    basePath: process.env['STORAGE_PATH'] ?? '.probe-data',
  };
}

async function main(): Promise<void> {
  const storageConfig = buildStorageConfig();
  const storage = createStorage(storageConfig);
  await storage.initialize();
  logger.info({ storage: storageConfig.type }, 'Storage initialized');

  const app = express();

  // Health check (before auth/rate-limit)
  app.get('/health', (_req, res) => {
    const mem = process.memoryUsage();
    res.json({
      status: 'ok',
      uptime: process.uptime() * 1000,
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      storage: storageConfig.type,
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
      },
    });
  });
  app.get('/ready', (_req, res) => {
    res.json({ status: 'ready' });
  });

  // Middleware — CORS restricted to configured origins
  const corsOrigins = process.env['CORS_ORIGINS']?.split(',').map(s => s.trim()).filter(Boolean);
  app.use(cors(corsOrigins?.length ? { origin: corsOrigins, credentials: true } : undefined));
  app.use(express.json({ limit: '50mb' }));
  app.use(requestLogger);

  // Rate limiter: 200 req/s sustained, 500 burst per IP
  app.use(createRateLimiter({ maxRequests: 200, windowMs: 1000, burstSize: 500 }));

  // Authentication (disable via PROBE_AUTH_DISABLED=1 for development)
  const apiKeys = process.env['PROBE_API_KEYS']?.split(',').filter(Boolean) ?? [];
  const jwtSecret = process.env['PROBE_JWT_SECRET'] ?? '';
  const enableAuth = process.env['PROBE_AUTH_DISABLED'] !== '1' && (apiKeys.length > 0 || jwtSecret.length > 0);
  app.use(createAuthMiddleware({ apiKeys, jwtSecret, enableAuth }));

  // Shared session manager — backed by StoragePort
  const sessionManager = new SessionManager(storage);

  // Mount API routes — pass session manager via app.locals
  app.locals['sessionManager'] = sessionManager;
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/sessions', eventsRouter);
  app.use('/api/sessions', reportsRouter);

  // Serve dashboard static files in production
  const dashboardDist = resolve(join(__dirname, '../../dashboard/dist'));
  if (existsSync(dashboardDist)) {
    app.use(express.static(dashboardDist));
    // SPA fallback — serve index.html for non-API routes
    app.get('*', (_req, res, next) => {
      if (_req.path.startsWith('/api/')) return next();
      res.sendFile(join(dashboardDist, 'index.html'));
    });
    logger.info({ path: dashboardDist }, 'Dashboard served from static build');
  }

  // Error handlers — MUST be last
  app.use('/api/*', notFoundHandler);
  app.use(errorHandler);

  // Create HTTP server & attach WebSocket
  const server = createServer(app);
  setupWebSocket(server, sessionManager);

  server.listen(PORT, HOST, () => {
    logger.info({ host: HOST, port: PORT, auth: enableAuth ? 'enabled' : 'disabled' }, `Listening on http://${HOST}:${PORT}`);
  });

  // Graceful shutdown
  const shutdown = (): void => {
    logger.info('Shutting down...');
    sessionManager.destroy();
    storage.close().catch(() => {});
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
    // Force exit after 5s
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
