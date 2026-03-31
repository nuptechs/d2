// ============================================================
// Prometheus Metrics Registry — Centralized metric definitions
// ============================================================

import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';

// Isolated registry — avoids polluting the global default registry in tests
export const registry = new Registry();

// Collect Node.js default metrics (event loop lag, memory, CPU, GC, etc.)
collectDefaultMetrics({ register: registry, prefix: 'probe_' });

// ---- HTTP ----

export const httpRequestsTotal = new Counter({
  name: 'probe_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'probe_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestSize = new Histogram({
  name: 'probe_http_request_size_bytes',
  help: 'HTTP request body size in bytes',
  labelNames: ['method', 'route'] as const,
  buckets: [100, 500, 1000, 5000, 10000, 50000, 100000, 500000, 1000000],
  registers: [registry],
});

// ---- Sessions ----

export const sessionsCreatedTotal = new Counter({
  name: 'probe_sessions_created_total',
  help: 'Total debug sessions created',
  registers: [registry],
});

export const sessionsDeletedTotal = new Counter({
  name: 'probe_sessions_deleted_total',
  help: 'Total debug sessions deleted',
  registers: [registry],
});

export const sessionsPurgedTotal = new Counter({
  name: 'probe_sessions_purged_total',
  help: 'Total sessions auto-purged (TTL expired)',
  registers: [registry],
});

export const sessionsActive = new Gauge({
  name: 'probe_sessions_active',
  help: 'Number of sessions currently in capturing or paused state',
  registers: [registry],
});

export const sessionStatusChanges = new Counter({
  name: 'probe_session_status_changes_total',
  help: 'Total session status transitions',
  labelNames: ['from_status', 'to_status'] as const,
  registers: [registry],
});

// ---- Events ----

export const eventsIngestedTotal = new Counter({
  name: 'probe_events_ingested_total',
  help: 'Total events ingested',
  labelNames: ['source'] as const,
  registers: [registry],
});

export const eventBatchSize = new Histogram({
  name: 'probe_event_batch_size',
  help: 'Number of events per ingest batch',
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [registry],
});

export const eventIngestDuration = new Histogram({
  name: 'probe_event_ingest_duration_seconds',
  help: 'Time to ingest a batch of events (storage + correlation)',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

// ---- Correlation ----

export const correlatorRebuildsTotal = new Counter({
  name: 'probe_correlator_rebuilds_total',
  help: 'Total correlator cold rebuilds from storage',
  registers: [registry],
});

export const correlatorRebuildDuration = new Histogram({
  name: 'probe_correlator_rebuild_duration_seconds',
  help: 'Time to rebuild a correlator from storage',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const correlatorsCached = new Gauge({
  name: 'probe_correlators_cached',
  help: 'Number of correlators held in LRU cache',
  registers: [registry],
});

export const correlatorEvictions = new Counter({
  name: 'probe_correlator_evictions_total',
  help: 'Total correlator LRU evictions',
  registers: [registry],
});

// ---- Storage ----

export const storageOperationDuration = new Histogram({
  name: 'probe_storage_operation_duration_seconds',
  help: 'Storage operation duration by operation type',
  labelNames: ['operation', 'storage_type'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const storageOperationsTotal = new Counter({
  name: 'probe_storage_operations_total',
  help: 'Total storage operations by type and result',
  labelNames: ['operation', 'storage_type', 'result'] as const,
  registers: [registry],
});

export const storageErrors = new Counter({
  name: 'probe_storage_errors_total',
  help: 'Total storage operation errors',
  labelNames: ['operation', 'storage_type'] as const,
  registers: [registry],
});

// ---- WebSocket ----

export const wsConnectionsActive = new Gauge({
  name: 'probe_ws_connections_active',
  help: 'Current active WebSocket connections',
  registers: [registry],
});

export const wsConnectionsTotal = new Counter({
  name: 'probe_ws_connections_total',
  help: 'Total WebSocket connections (accepted)',
  registers: [registry],
});

export const wsConnectionsRejected = new Counter({
  name: 'probe_ws_connections_rejected_total',
  help: 'Total WebSocket connections rejected',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const wsMessagesReceived = new Counter({
  name: 'probe_ws_messages_received_total',
  help: 'Total WebSocket messages received from clients',
  labelNames: ['type'] as const,
  registers: [registry],
});

export const wsMessagesSent = new Counter({
  name: 'probe_ws_messages_sent_total',
  help: 'Total WebSocket messages sent to clients',
  registers: [registry],
});

export const wsSubscriptionsActive = new Gauge({
  name: 'probe_ws_subscriptions_active',
  help: 'Total active WebSocket subscriptions across all clients',
  registers: [registry],
});

// ---- Purge ----

export const purgeRunsTotal = new Counter({
  name: 'probe_purge_runs_total',
  help: 'Total auto-purge cycle runs',
  registers: [registry],
});

export const purgeDuration = new Histogram({
  name: 'probe_purge_duration_seconds',
  help: 'Duration of purge cycle',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10],
  registers: [registry],
});

// ---- Errors ----

export const errorsTotal = new Counter({
  name: 'probe_errors_total',
  help: 'Total application errors by type',
  labelNames: ['type'] as const,
  registers: [registry],
});

/** Reset all custom metrics (for testing) */
export function resetMetrics(): void {
  httpRequestsTotal.reset();
  httpRequestDuration.reset();
  httpRequestSize.reset();
  sessionsCreatedTotal.reset();
  sessionsDeletedTotal.reset();
  sessionsPurgedTotal.reset();
  sessionsActive.reset();
  sessionStatusChanges.reset();
  eventsIngestedTotal.reset();
  eventBatchSize.reset();
  eventIngestDuration.reset();
  correlatorRebuildsTotal.reset();
  correlatorRebuildDuration.reset();
  correlatorsCached.reset();
  correlatorEvictions.reset();
  storageOperationDuration.reset();
  storageOperationsTotal.reset();
  storageErrors.reset();
  wsConnectionsActive.reset();
  wsConnectionsTotal.reset();
  wsConnectionsRejected.reset();
  wsMessagesReceived.reset();
  wsMessagesSent.reset();
  wsSubscriptionsActive.reset();
  purgeRunsTotal.reset();
  purgeDuration.reset();
  errorsTotal.reset();
}
