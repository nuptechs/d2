// ============================================================
// CorrelatorPort — Abstraction for event correlation logic
// Adapters: RequestId strategy, Temporal strategy, URL matching
// ============================================================

import type {
  ProbeEvent,
  CorrelationGroup,
  Timeline,
  CorrelationConfig,
} from '../types/index.js';

export abstract class CorrelatorPort {
  // ---- Lifecycle ----
  abstract initialize(config: CorrelationConfig): void;
  abstract reset(): void;

  // ---- Event ingestion ----
  abstract ingest(event: ProbeEvent): void;

  // ---- Query ----
  abstract getGroups(): CorrelationGroup[];
  abstract getGroup(id: string): CorrelationGroup | undefined;
  abstract getGroupByCorrelationId(correlationId: string): CorrelationGroup | undefined;

  // ---- Timeline ----
  abstract buildTimeline(): Timeline;

  // ---- Event subscription ----
  abstract onGroupCreated(handler: (group: CorrelationGroup) => void): () => void;
  abstract onGroupUpdated(handler: (group: CorrelationGroup) => void): () => void;
}
