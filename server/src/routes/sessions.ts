// ============================================================
// Sessions REST API — CRUD for debug sessions
// ============================================================

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SessionConfig, SessionStatus } from '@probe/core';
import { generateSessionId } from '@probe/core';
import type { SessionManager } from '../services/session-manager.js';

export const sessionsRouter = Router();

function getManager(req: Request): SessionManager {
  return req.app.locals['sessionManager'] as SessionManager;
}

// POST /api/sessions — Create new debug session
sessionsRouter.post('/', (req: Request, res: Response) => {
  const manager = getManager(req);
  const body = req.body as { name?: string; config?: SessionConfig; tags?: string[] } | undefined;

  const name = body?.name ?? `session-${generateSessionId().slice(0, 8)}`;
  const config = body?.config ?? {};
  const tags = body?.tags;

  const session = manager.createSession(name, config, tags);
  res.status(201).json(session);
});

// GET /api/sessions — List all sessions
sessionsRouter.get('/', (req: Request, res: Response) => {
  const manager = getManager(req);
  const sessions = manager.listSessions();
  res.json({ sessions, total: sessions.length });
});

// GET /api/sessions/:id — Get session details
sessionsRouter.get('/:id', (req: Request, res: Response) => {
  const manager = getManager(req);
  const session = manager.getSession(req.params['id'] as string);

  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  res.json(session);
});

// DELETE /api/sessions/:id — Delete session
sessionsRouter.delete('/:id', (req: Request, res: Response) => {
  const manager = getManager(req);
  const deleted = manager.deleteSession(req.params['id'] as string);

  if (!deleted) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  res.status(204).send();
});

// PATCH /api/sessions/:id/status — Update session status
sessionsRouter.patch('/:id/status', (req: Request, res: Response) => {
  const manager = getManager(req);
  const body = req.body as { status?: string } | undefined;
  const newStatus = body?.status;

  const validStatuses: SessionStatus[] = ['idle', 'capturing', 'paused', 'completed', 'error'];
  if (!newStatus || !validStatuses.includes(newStatus as SessionStatus)) {
    res.status(400).json({
      error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
    });
    return;
  }

  const session = manager.updateSessionStatus(req.params['id'] as string, newStatus as SessionStatus);

  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  res.json(session);
});
