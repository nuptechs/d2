// ============================================================
// TimelineBuilder — Constructs a sorted, annotated timeline
// ============================================================

import type {
  ProbeEvent,
  CorrelationGroup,
  Timeline,
  TimelineEntry,
  TimelineStats,
  EventSource,
  ResponseEvent,
} from '@probe/core';
import { isResponseEvent } from '@probe/core';

const SOURCE_DEPTH: Record<EventSource, number> = {
  browser: 0,
  network: 1,
  sdk: 2,
  log: 3,
  correlation: 0,
};

export function buildTimeline(
  groups: CorrelationGroup[],
  allEvents: readonly ProbeEvent[],
  sessionId: string,
): Timeline {
  // Build a map of eventId → groupId for quick lookup
  const eventToGroup = new Map<string, string>();
  for (const group of groups) {
    for (const event of group.events) {
      eventToGroup.set(event.id, group.id);
    }
  }

  // Sort events chronologically (stable sort for equal timestamps)
  const sorted = [...allEvents].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));

  const entries: TimelineEntry[] = sorted.map((event) => ({
    event,
    depth: SOURCE_DEPTH[event.source] ?? 0,
    groupId: eventToGroup.get(event.id),
  }));

  const stats = computeStats(allEvents, groups);

  const startTime = sorted.length > 0 ? sorted[0]!.timestamp : 0;
  const endTime = sorted.length > 0 ? sorted[sorted.length - 1]!.timestamp : 0;

  return {
    sessionId,
    entries,
    duration: endTime - startTime,
    startTime,
    endTime,
    stats,
  };
}

function computeStats(
  allEvents: readonly ProbeEvent[],
  groups: CorrelationGroup[],
): TimelineStats {
  const bySource: Record<string, number> = {
    browser: 0,
    network: 0,
    log: 0,
    sdk: 0,
    correlation: 0,
  };

  let errors = 0;
  let responseTimeSum = 0;
  let responseCount = 0;

  for (const event of allEvents) {
    bySource[event.source] = (bySource[event.source] ?? 0) + 1;

    // Count errors
    if (event.source === 'browser') {
      const be = event as ProbeEvent & { type?: string };
      if (be.type === 'error') errors++;
    }
    if (event.source === 'log') {
      const le = event as ProbeEvent & { level?: string };
      if (le.level === 'error' || le.level === 'fatal') errors++;
    }

    // Accumulate response times
    if (isResponseEvent(event)) {
      const res = event as ResponseEvent;
      responseTimeSum += res.duration;
      responseCount++;
      if (res.statusCode >= 400) errors++;
    }
  }

  return {
    totalEvents: allEvents.length,
    bySource: bySource as Record<EventSource, number>,
    correlationGroups: groups.length,
    errors,
    avgResponseTime: responseCount > 0 ? responseTimeSum / responseCount : undefined,
  };
}
