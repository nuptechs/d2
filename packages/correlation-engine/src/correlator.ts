// ============================================================
// EventCorrelator — Main correlation engine implementation
// ============================================================

import type {
  ProbeEvent,
  CorrelationGroup,
  CorrelationSummary,
  CorrelationConfig,
  CorrelationStrategyType,
  Timeline,
} from '@probe/core';
import { CorrelatorPort, generateId, nowMs } from '@probe/core';

import { CorrelationStrategy } from './strategies/base.strategy.js';
import { RequestIdStrategy } from './strategies/request-id.strategy.js';
import { TemporalStrategy } from './strategies/temporal.strategy.js';
import { UrlMatchingStrategy } from './strategies/url-matching.strategy.js';
import { buildGroupSummary } from './summary-builder.js';
import { buildTimeline } from './timeline/timeline-builder.js';

// ---- Internal mutable group ----

interface MutableCorrelationGroup {
  readonly id: string;
  readonly sessionId: string;
  correlationId: string;
  readonly createdAt: number;
  events: ProbeEvent[];
  summary: CorrelationSummary;
}

function toReadonly(group: MutableCorrelationGroup): CorrelationGroup {
  return {
    id: group.id,
    sessionId: group.sessionId,
    correlationId: group.correlationId,
    createdAt: group.createdAt,
    events: [...group.events],
    summary: { ...group.summary },
  };
}

export class EventCorrelator extends CorrelatorPort {
  private config: CorrelationConfig | null = null;
  private strategies: CorrelationStrategy[] = [];
  private groups = new Map<string, MutableCorrelationGroup>();
  private allEvents: ProbeEvent[] = [];
  private currentSessionId = '';

  private createdHandlers = new Set<(group: CorrelationGroup) => void>();
  private updatedHandlers = new Set<(group: CorrelationGroup) => void>();

  // ---- Lifecycle ----

  initialize(config: CorrelationConfig): void {
    this.config = config;
    this.strategies = this.buildStrategies(config);
  }

  reset(): void {
    this.groups.clear();
    this.allEvents = [];
    this.currentSessionId = '';
    this.createdHandlers.clear();
    this.updatedHandlers.clear();
  }

  // ---- Event ingestion ----

  ingest(event: ProbeEvent): void {
    if (!this.config) {
      throw new Error('CorrelationEngine not initialized — call initialize() first');
    }

    this.allEvents.push(event);
    if (!this.currentSessionId) {
      this.currentSessionId = event.sessionId;
    }

    // Expire old groups before attempting correlation
    this.expireGroups();

    // Try each strategy in order to find an existing group
    let matchedGroupId: string | null = null;
    const readonlySnapshot = this.readonlyGroupSnapshot();

    for (const strategy of this.strategies) {
      matchedGroupId = strategy.tryCorrelate(event, readonlySnapshot);
      if (matchedGroupId) break;
    }

    if (matchedGroupId) {
      this.addEventToGroup(matchedGroupId, event);
    } else {
      this.createGroup(event);
    }
  }

  // ---- Query ----

  getGroups(): CorrelationGroup[] {
    const result: CorrelationGroup[] = [];
    for (const group of this.groups.values()) {
      result.push(toReadonly(group));
    }
    return result;
  }

  getGroup(id: string): CorrelationGroup | undefined {
    const g = this.groups.get(id);
    return g ? toReadonly(g) : undefined;
  }

  getGroupByCorrelationId(correlationId: string): CorrelationGroup | undefined {
    for (const group of this.groups.values()) {
      if (group.correlationId === correlationId) {
        return toReadonly(group);
      }
    }
    return undefined;
  }

  // ---- Timeline ----

  buildTimeline(): Timeline {
    return buildTimeline(this.getGroups(), this.allEvents, this.currentSessionId);
  }

  // ---- Event subscription ----

  onGroupCreated(handler: (group: CorrelationGroup) => void): () => void {
    this.createdHandlers.add(handler);
    return () => { this.createdHandlers.delete(handler); };
  }

  onGroupUpdated(handler: (group: CorrelationGroup) => void): () => void {
    this.updatedHandlers.add(handler);
    return () => { this.updatedHandlers.delete(handler); };
  }

  // ---- Internal ----

  private buildStrategies(config: CorrelationConfig): CorrelationStrategy[] {
    const strategyMap: Record<CorrelationStrategyType, () => CorrelationStrategy> = {
      'request-id': () => new RequestIdStrategy(),
      'temporal': () => new TemporalStrategy(config.temporalWindowMs),
      'url-matching': () => new UrlMatchingStrategy(),
      'trace-id': () => new RequestIdStrategy(), // trace-id uses same logic with correlationId
    };

    return config.strategies.map((name) => {
      const factory = strategyMap[name];
      if (!factory) throw new Error(`Unknown correlation strategy: ${name}`);
      return factory();
    });
  }

  private createGroup(event: ProbeEvent): void {
    const id = generateId();
    const correlationId = event.correlationId ?? id;

    const group: MutableCorrelationGroup = {
      id,
      sessionId: event.sessionId,
      correlationId,
      createdAt: event.timestamp,
      events: [event],
      summary: buildGroupSummary([event]),
    };

    this.groups.set(id, group);
    const frozen = toReadonly(group);
    for (const handler of this.createdHandlers) {
      try { handler(frozen); } catch { /* swallow handler errors */ }
    }
  }

  private addEventToGroup(groupId: string, event: ProbeEvent): void {
    const group = this.groups.get(groupId);
    if (!group) return;

    group.events.push(event);
    group.summary = buildGroupSummary(group.events);

    // If this event carries a more specific correlationId, adopt it
    if (event.correlationId && group.correlationId === group.id) {
      group.correlationId = event.correlationId;
    }

    const frozen = toReadonly(group);
    for (const handler of this.updatedHandlers) {
      try { handler(frozen); } catch { /* swallow handler errors */ }
    }
  }

  private expireGroups(): void {
    // Expiration is handled during readonlyGroupSnapshot() — timed-out groups
    // are excluded from active correlation but kept for the final timeline.
  }

  /** Build a read-only snapshot for strategies to inspect */
  private readonlyGroupSnapshot(): Map<string, CorrelationGroup> {
    if (!this.config) return new Map();
    const now = nowMs();
    const timeout = this.config.groupTimeoutMs;
    const snapshot = new Map<string, CorrelationGroup>();

    for (const [id, group] of this.groups) {
      // Exclude timed-out groups from active correlation
      let latest = group.createdAt;
      for (const e of group.events) {
        if (e.timestamp > latest) latest = e.timestamp;
      }
      if (now - latest <= timeout) {
        snapshot.set(id, toReadonly(group));
      }
    }

    return snapshot;
  }
}
