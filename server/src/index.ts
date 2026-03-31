// ============================================================
// @probe/server — Express + WebSocket server entry point
// ============================================================

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { sessionsRouter } from './routes/sessions.js';
import { eventsRouter } from './routes/events.js';
import { reportsRouter } from './routes/reports.js';
import { metricsRouter } from './routes/metrics.js';
import { SessionManager } from './services/session-manager.js';
import { setupWebSocket } from './ws/realtime.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createRateLimiter } from './middleware/rate-limiter.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { logger } from './logger.js';
import { createStorage } from '@probe/core';
import type { StorageConfig } from '@probe/core';
import { instrumentStorage } from './lib/instrumented-storage.js';
import {
  sessionsActive,
  wsConnectionsActive,
  correlatorsCached,
  httpRequestsTotal,
  errorsTotal,
} from './lib/metrics.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ---- Environment validation ----
const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(7070),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().optional(),
  STORAGE_TYPE: z.enum(['memory', 'file', 'postgres']).default('memory'),
  STORAGE_PATH: z.string().default('.probe-data'),
  PROBE_JWT_SECRET: z.string().optional(),
  PROBE_API_KEYS: z.string().default(''),
  PROBE_AUTH_DISABLED: z.string().optional(),
  CORS_ORIGINS: z.string().default(''),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

const env = envSchema.parse(process.env);

// ---- Storage initialization ----
function buildStorageConfig(): StorageConfig {
  if (env.DATABASE_URL) {
    return { type: 'postgres', connectionString: env.DATABASE_URL };
  }
  return {
    type: env.STORAGE_TYPE as StorageConfig['type'],
    basePath: env.STORAGE_PATH,
  };
}

async function main(): Promise<void> {
  const storageConfig = buildStorageConfig();
  const rawStorage = createStorage(storageConfig);
  const storage = instrumentStorage(rawStorage, storageConfig.type);
  await storage.initialize();
  logger.info({ storage: storageConfig.type }, 'Storage initialized');

  const app = express();

  // Metrics endpoint (before auth — scrapers don't carry tokens)
  app.use(metricsRouter);

  // Health check (before auth/rate-limit) — minimal info for load balancers
  app.get('/health', async (_req, res) => {
    let storageOk = true;
    try {
      await storage.listSessionsPaginated({ limit: 1, offset: 0 });
    } catch {
      storageOk = false;
    }
    const status = storageOk ? 'ok' : 'degraded';

    // Collect lightweight metric snapshot for health consumers
    const totalRequests = (await httpRequestsTotal.get()).values.reduce((sum, v) => sum + v.value, 0);
    const totalErrors = (await errorsTotal.get()).values.reduce((sum, v) => sum + v.value, 0);

    res.status(storageOk ? 200 : 503).json({
      status,
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      storageOk,
      metrics: {
        activeSessions: (await sessionsActive.get()).values[0]?.value ?? 0,
        activeWsConnections: (await wsConnectionsActive.get()).values[0]?.value ?? 0,
        cachedCorrelators: (await correlatorsCached.get()).values[0]?.value ?? 0,
        totalRequests,
        totalErrors,
        errorRate: totalRequests > 0 ? +(totalErrors / totalRequests * 100).toFixed(2) : 0,
      },
    });
  });
  app.get('/ready', async (_req, res) => {
    try {
      await storage.listSessionsPaginated({ limit: 1, offset: 0 });
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'not ready', reason: 'storage unavailable' });
    }
  });

  // Security headers
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

  // Middleware — CORS restricted to configured origins
  const corsOrigins = env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
  if (corsOrigins.length === 0 && env.NODE_ENV === 'production') {
    logger.warn('CORS_ORIGINS not set in production — rejecting cross-origin requests');
    app.use(cors({ origin: false }));
  } else {
    app.use(cors(corsOrigins.length ? { origin: corsOrigins, credentials: true } : undefined));
  }
  app.use(express.json({ type: 'application/json', limit: '10mb', strict: true }));
  app.use(requestLogger);

  // Rate limiters: generous for reads, stricter for writes
  const readRateLimiter = createRateLimiter({ maxRequests: 200, windowMs: 1000, burstSize: 500 });
  const writeRateLimiter = createRateLimiter({ maxRequests: 50, windowMs: 1000, burstSize: 100 });
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      readRateLimiter(req, res, next);
    } else {
      writeRateLimiter(req, res, next);
    }
  });

  // Authentication (disable via PROBE_AUTH_DISABLED=1 for dev/test ONLY)
  const MIN_API_KEY_LENGTH = 16;
  const MIN_JWT_SECRET_LENGTH = 32;
  const apiKeys = env.PROBE_API_KEYS.split(',').filter(Boolean);
  const jwtSecret = env.PROBE_JWT_SECRET ?? '';
  if (env.PROBE_AUTH_DISABLED === '1' && env.NODE_ENV === 'production') {
    logger.fatal('PROBE_AUTH_DISABLED=1 is forbidden in production — aborting');
    process.exit(1);
  }
  if (env.NODE_ENV === 'production' && apiKeys.length === 0 && !jwtSecret) {
    logger.fatal('Production requires PROBE_API_KEYS or PROBE_JWT_SECRET — aborting');
    process.exit(1);
  }
  const weakKeys = apiKeys.filter(k => k.length < MIN_API_KEY_LENGTH);
  if (weakKeys.length > 0) {
    logger.fatal({ count: weakKeys.length }, `API keys must be at least ${MIN_API_KEY_LENGTH} characters — aborting`);
    process.exit(1);
  }
  if (jwtSecret && jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    logger.fatal(`PROBE_JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters — aborting`);
    process.exit(1);
  }
  const authDisabledByEnv = env.PROBE_AUTH_DISABLED === '1' && env.NODE_ENV !== 'production';
  const enableAuth = !authDisabledByEnv && (apiKeys.length > 0 || jwtSecret.length > 0);
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
  const wss = setupWebSocket(server, sessionManager, { apiKeys, jwtSecret, enableAuth });

  server.listen(env.PORT, env.HOST, () => {
    logger.info({ host: env.HOST, port: env.PORT, auth: enableAuth ? 'enabled' : 'disabled' }, `Listening on http://${env.HOST}:${env.PORT}`);
  });

  // Graceful shutdown — drain connections before exit
  let isShuttingDown = false;
  const shutdown = (): void => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info('Shutting down gracefully...');

    // Stop accepting new connections
    server.close(async () => {
      try {
        // Close all WebSocket connections gracefully
        for (const ws of wss.clients) { ws.close(1001, 'Server shutting down'); }
        wss.close();
        sessionManager.destroy();
        await storage.close();
        logger.info('Shutdown complete');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during shutdown');
        process.exit(1);
      }
    });

    // Force exit after 30s (enough time to drain)
    setTimeout(() => {
      logger.warn('Force exit — shutdown timeout exceeded');
      process.exit(1);
    }, 30_000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// ---- Process-level safety nets ----
process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled promise rejection — crashing');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — crashing');
  process.exit(1);
});

main().catch((err) => {
  logger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
