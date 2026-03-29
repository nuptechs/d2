// ============================================================
// @probe/server — Express + WebSocket server entry point
// ============================================================

import { createServer } from 'node:http';
import express from 'express';
import cors from 'cors';
import { sessionsRouter } from './routes/sessions.js';
import { eventsRouter } from './routes/events.js';
import { reportsRouter } from './routes/reports.js';
import { SessionManager } from './services/session-manager.js';
import { setupWebSocket } from './ws/realtime.js';

const PORT = parseInt(process.env['PORT'] ?? '7070', 10);
const HOST = process.env['HOST'] ?? '0.0.0.0';

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Shared session manager
const sessionManager = new SessionManager();

// Mount routes — pass session manager via app.locals
app.locals['sessionManager'] = sessionManager;
app.use('/api/sessions', sessionsRouter);
app.use('/api/sessions', eventsRouter);
app.use('/api/sessions', reportsRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Create HTTP server & attach WebSocket
const server = createServer(app);
setupWebSocket(server, sessionManager);

server.listen(PORT, HOST, () => {
  console.log(`[probe-server] Listening on http://${HOST}:${PORT}`);
  console.log(`[probe-server] WebSocket available on ws://${HOST}:${PORT}`);
});

// Graceful shutdown
const shutdown = (): void => {
  console.log('\n[probe-server] Shutting down...');
  server.close(() => {
    console.log('[probe-server] Closed.');
    process.exit(0);
  });
  // Force exit after 5s
  setTimeout(() => process.exit(1), 5000).unref();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app, server };
