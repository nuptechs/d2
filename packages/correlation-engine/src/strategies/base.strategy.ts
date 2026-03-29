// ============================================================
// CorrelationStrategy — Abstract base for correlation strategies
// ============================================================

import type { ProbeEvent, CorrelationGroup, CorrelationStrategyType } from '@probe/core';

export abstract class CorrelationStrategy {
  abstract tryCorrelate(
    event: ProbeEvent,
    existingGroups: Map<string, CorrelationGroup>,
  ): string | null;

  abstract getName(): CorrelationStrategyType;
}
