// ============================================================
// Metrics endpoint — Exposes Prometheus metrics at /metrics
// ============================================================

import { Router } from 'express';
import type { Request, Response } from 'express';
import { registry } from '../lib/metrics.js';

export const metricsRouter = Router();

metricsRouter.get('/metrics', async (_req: Request, res: Response) => {
  try {
    const metrics = await registry.metrics();
    res.set('Content-Type', registry.contentType);
    res.end(metrics);
  } catch (err) {
    res.status(500).end('# Error collecting metrics');
  }
});
