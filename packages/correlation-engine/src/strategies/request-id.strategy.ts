// ============================================================
// RequestIdStrategy — Correlates events sharing a requestId or correlationId
// ============================================================

import type {
  ProbeEvent,
  CorrelationGroup,
  CorrelationStrategyType,
  NetworkEvent,
  SdkEvent,
  LogEvent,
} from '@probe/core';
import { isNetworkEvent, isSdkEvent, isLogEvent } from '@probe/core';
import { CorrelationStrategy } from './base.strategy.js';

export class RequestIdStrategy extends CorrelationStrategy {
  getName(): CorrelationStrategyType {
    return 'request-id';
  }

  tryCorrelate(
    event: ProbeEvent,
    existingGroups: Map<string, CorrelationGroup>,
  ): string | null {
    const eventCorrelationId = this.extractCorrelationKey(event);
    if (!eventCorrelationId) return null;

    for (const [groupId, group] of existingGroups) {
      if (group.correlationId === eventCorrelationId) {
        return groupId;
      }
      for (const existing of group.events) {
        const existingKey = this.extractCorrelationKey(existing);
        if (existingKey && existingKey === eventCorrelationId) {
          return groupId;
        }
      }
    }

    return null;
  }

  private extractCorrelationKey(event: ProbeEvent): string | undefined {
    if (event.correlationId) {
      return event.correlationId;
    }

    if (isNetworkEvent(event)) {
      return (event as NetworkEvent).requestId;
    }

    if (isSdkEvent(event)) {
      const sdk = event as SdkEvent & { requestId?: string };
      return sdk.requestId;
    }

    if (isLogEvent(event)) {
      const log = event as LogEvent;
      const structured = log.structured;
      if (structured) {
        const cid =
          structured['correlationId'] ??
          structured['correlation_id'] ??
          structured['requestId'] ??
          structured['request_id'] ??
          structured['traceId'] ??
          structured['trace_id'];
        if (typeof cid === 'string') return cid;
      }
    }

    return undefined;
  }
}
