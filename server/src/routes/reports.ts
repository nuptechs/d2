// ============================================================
// Reports REST API — Generate reports from sessions
// ============================================================

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SessionManager } from '../services/session-manager.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { logger } from '../logger.js';
import { sessionIdSchema } from './sessions.js';

export const reportsRouter = Router();

function getManager(req: Request): SessionManager {
  return req.app.locals['sessionManager'] as SessionManager;
}

// GET /api/sessions/:id/report — Generate report
reportsRouter.get('/:id/report', asyncHandler(async (req: Request, res: Response) => {
  const manager = getManager(req);
  const idResult = sessionIdSchema.safeParse(req.params['id']);
  if (!idResult.success) { res.status(400).json({ error: 'Invalid session ID' }); return; }
  const sessionId = idResult.data;

  const session = await manager.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const format = (req.query['format'] as string) ?? 'html';
  const validFormats = ['html', 'json', 'markdown'];
  if (!validFormats.includes(format)) {
    res.status(400).json({ error: `Invalid format. Must be one of: ${validFormats.join(', ')}` });
    return;
  }

  const includeScreenshots = req.query['includeScreenshots'] !== 'false';
  const includeRequestBodies = req.query['includeRequestBodies'] === 'true';
  const maxEventsPerGroup = Math.min(
    Number(req.query['maxEventsPerGroup']) || 500,
    1000,
  );

  try {
    const timeline = await manager.getTimeline(sessionId);
    const groups = await manager.getCorrelationGroups(sessionId);

    if (!timeline || !groups) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const { createReporter } = await import('@probe/reporter');
    const reporter = createReporter(format as 'html' | 'json' | 'markdown');

    const content = await reporter.generate(
      { session, timeline, correlationGroups: groups },
      { includeScreenshots, includeRequestBodies, maxEventsPerGroup },
    );

    res.set('Content-Type', reporter.getMimeType());
    res.send(content);
  } catch (error) {
    logger.error({ err: error, sessionId, format }, 'Report generation failed');
    res.status(500).json({ error: 'Report generation failed' });
  }
}));
