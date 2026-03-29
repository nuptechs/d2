// ============================================================
// TemporalStrategy — Correlates events within a sliding time window
// ============================================================

import type {
  ProbeEvent,
  CorrelationGroup,
  CorrelationStrategyType,
} from '@probe/core';
import { isBrowserEvent } from '@probe/core';
import { CorrelationStrategy } from './base.strategy.js';

export class TemporalStrategy extends CorrelationStrategy {
  private readonly windowMs: number;

  constructor(windowMs: number) {
    super();
    this.windowMs = windowMs;
  }

  getName(): CorrelationStrategyType {
    return 'temporal';
  }

  tryCorrelate(
    event: ProbeEvent,
    existingGroups: Map<string, CorrelationGroup>,
  ): string | null {
    // Browser click/navigation events act as triggers — they start groups,
    // they don't get correlated into existing ones by time alone.
    if (isBrowserEvent(event)) {
      const be = event as import('@probe/core').BrowserEvent;
      if (be.type === 'click' || be.type === 'navigation') {
        return null;
      }
    }

    let bestGroupId: string | null = null;
    let smallestGap = Infinity;

    for (const [groupId, group] of existingGroups) {
      const latestTimestamp = this.getLatestTimestamp(group);
      const gap = event.timestamp - latestTimestamp;

      // Event must be within the temporal window of the group's latest event
      if (gap >= 0 && gap <= this.windowMs && gap < smallestGap) {
        smallestGap = gap;
        bestGroupId = groupId;
      }
    }

    return bestGroupId;
  }

  private getLatestTimestamp(group: CorrelationGroup): number {
    let latest = group.createdAt;
    for (const e of group.events) {
      if (e.timestamp > latest) latest = e.timestamp;
    }
    return latest;
  }
}
