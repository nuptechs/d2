// ============================================================
// Events REST API — Ingest and query events for a session
// ============================================================

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ProbeEvent, EventSource } from '@probe/core';
import type { SessionManager } from '../services/session-manager.js';
import { asyncHandler } from '../middleware/async-handler.js';

export const eventsRouter = Router();

const MAX_BATCH_SIZE = 1000;

function getManager(req: Request): SessionManager {
  return req.app.locals['sessionManager'] as SessionManager;
}

// POST /api/sessions/:id/events — Ingest events (batch)
eventsRouter.post('/:id/events', asyncHandler(async (req: Request, res: Response) => {
  const manager = getManager(req);
  const sessionId = req.params['id'] as string;

  const session = await manager.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const body = req.body as { events?: ProbeEvent[] } | ProbeEvent[] | undefined;
  const events: ProbeEvent[] = Array.isArray(body) ? body : body?.events ?? [];

  if (!Array.isArray(events)) {
    res.status(400).json({ error: 'Request body must contain an events array' });
    return;
  }

  if (events.length > MAX_BATCH_SIZE) {
    res.status(400).json({
      error: `Batch size exceeds maximum of ${MAX_BATCH_SIZE} events`,
    });
    return;
  }

  // Validate event structure
  for (const event of events) {
    if (!event.id || !event.sessionId || !event.timestamp || !event.source) {
      res.status(400).json({
        error: 'Each event must have id, sessionId, timestamp, and source fields',
      });
      return;
    }
  }

  const ingested = await manager.ingestEvents(sessionId, events);
  res.status(201).json({ ingested });
}));

// GET /api/sessions/:id/events — Query events with filters + pagination
eventsRouter.get('/:id/events', asyncHandler(async (req: Request, res: Response) => {
  const manager = getManager(req);
  const sessionId = req.params['id'] as string;

  const session = await manager.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const source = req.query['source'] as EventSource | undefined;
  const type = req.query['type'] as string | undefined;

  const rawFromTime = req.query['fromTime'] ? parseInt(req.query['fromTime'] as string, 10) : undefined;
  const rawToTime = req.query['toTime'] ? parseInt(req.query['toTime'] as string, 10) : undefined;
  const rawLimit = req.query['limit'] ? parseInt(req.query['limit'] as string, 10) : 500;
  const rawOffset = req.query['offset'] ? parseInt(req.query['offset'] as string, 10) : 0;

  // Validate numeric params
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 10_000) : 500;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const fromTime = rawFromTime !== undefined && Number.isFinite(rawFromTime) ? rawFromTime : undefined;
  const toTime = rawToTime !== undefined && Number.isFinite(rawToTime) ? rawToTime : undefined;

  const result = await manager.getEvents(sessionId, { source, type, fromTime, toTime, limit, offset });
  res.json({ events: result.events, total: result.total });
}));

// GET /api/sessions/:id/timeline — Get correlated timeline
eventsRouter.get('/:id/timeline', asyncHandler(async (req: Request, res: Response) => {
  const manager = getManager(req);
  const sessionId = req.params['id'] as string;

  const timeline = await manager.getTimeline(sessionId);
  if (!timeline) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  res.json(timeline);
}));

// GET /api/sessions/:id/groups — Get correlation groups
eventsRouter.get('/:id/groups', asyncHandler(async (req: Request, res: Response) => {
  const manager = getManager(req);
  const sessionId = req.params['id'] as string;

  const groups = await manager.getCorrelationGroups(sessionId);
  if (!groups) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  res.json({ groups, total: groups.length });
}));
