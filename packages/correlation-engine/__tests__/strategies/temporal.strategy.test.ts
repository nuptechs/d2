import { describe, it, expect, beforeEach } from 'vitest';
import { TemporalStrategy } from '../../src/strategies/temporal.strategy.js';
import type {
  ProbeEvent,
  CorrelationGroup,
  CorrelationSummary,
  BrowserEvent,
} from '@probe/core';

// ---- Helpers ----

let idCounter = 0;
function uid(): string {
  return `test-id-${++idCounter}`;
}

function makeSummary(): CorrelationSummary {
  return {
    trigger: 'test',
    hasScreenshot: false,
    hasError: false,
    errorMessages: [],
    logCount: 0,
    dbQueryCount: 0,
    dbTotalDuration: 0,
    entitiesInvolved: [],
  };
}

function makeGroup(
  events: ProbeEvent[],
  createdAt: number,
  id = `group-${uid()}`,
): CorrelationGroup {
  return {
    id,
    sessionId: 'sess-test',
    correlationId: '',
    createdAt,
    events,
    summary: makeSummary(),
  };
}

function makeEvent(timestamp: number, source: ProbeEvent['source'] = 'sdk', overrides: Record<string, unknown> = {}): ProbeEvent {
  return {
    id: uid(),
    sessionId: 'sess-test',
    timestamp,
    source,
    type: 'custom',
    ...overrides,
  };
}

function makeBrowserClickEvent(timestamp: number): BrowserEvent {
  return {
    id: uid(),
    sessionId: 'sess-test',
    timestamp,
    source: 'browser',
    type: 'click',
    pageUrl: 'https://app.example.com',
  } as BrowserEvent;
}

function makeBrowserNavEvent(timestamp: number): BrowserEvent {
  return {
    id: uid(),
    sessionId: 'sess-test',
    timestamp,
    source: 'browser',
    type: 'navigation',
    pageUrl: 'https://app.example.com',
  } as BrowserEvent;
}

function makeBrowserConsoleEvent(timestamp: number): BrowserEvent {
  return {
    id: uid(),
    sessionId: 'sess-test',
    timestamp,
    source: 'browser',
    type: 'console',
    pageUrl: 'https://app.example.com',
  } as BrowserEvent;
}

const WINDOW_MS = 5000;

// ---- Tests ----

describe('TemporalStrategy', () => {
  let strategy: TemporalStrategy;

  beforeEach(() => {
    strategy = new TemporalStrategy(WINDOW_MS);
    idCounter = 0;
  });

  it('returns temporal as name', () => {
    expect(strategy.getName()).toBe('temporal');
  });

  // -- Basic temporal grouping --

  it('correlates event within temporal window of group', () => {
    const baseTs = 1700000000000;
    const groups = new Map<string, CorrelationGroup>();
    const existingEvent = makeEvent(baseTs);
    groups.set('g1', makeGroup([existingEvent], baseTs, 'g1'));

    const newEvent = makeEvent(baseTs + 1000); // 1s later, within 5s window
    const result = strategy.tryCorrelate(newEvent, groups);
    expect(result).toBe('g1');
  });

  it('does not correlate event outside temporal window', () => {
    const baseTs = 1700000000000;
    const groups = new Map<string, CorrelationGroup>();
    const existingEvent = makeEvent(baseTs);
    groups.set('g1', makeGroup([existingEvent], baseTs, 'g1'));

    const newEvent = makeEvent(baseTs + 6000); // 6s later, outside 5s window
    const result = strategy.tryCorrelate(newEvent, groups);
    expect(result).toBeNull();
  });

  // -- Boundary conditions --

  it('correlates event exactly at window boundary', () => {
    const baseTs = 1700000000000;
    const groups = new Map<string, CorrelationGroup>();
    const existingEvent = makeEvent(baseTs);
    groups.set('g1', makeGroup([existingEvent], baseTs, 'g1'));

    const newEvent = makeEvent(baseTs + WINDOW_MS); // exactly at boundary
    const result = strategy.tryCorrelate(newEvent, groups);
    expect(result).toBe('g1');
  });

  it('does not correlate event 1ms beyond window boundary', () => {
    const baseTs = 1700000000000;
    const groups = new Map<string, CorrelationGroup>();
    const existingEvent = makeEvent(baseTs);
    groups.set('g1', makeGroup([existingEvent], baseTs, 'g1'));

    const newEvent = makeEvent(baseTs + WINDOW_MS + 1); // 1ms beyond
    const result = strategy.tryCorrelate(newEvent, groups);
    expect(result).toBeNull();
  });

  it('correlates event at zero gap (same timestamp)', () => {
    const baseTs = 1700000000000;
    const groups = new Map<string, CorrelationGroup>();
    const existingEvent = makeEvent(baseTs);
    groups.set('g1', makeGroup([existingEvent], baseTs, 'g1'));

    const newEvent = makeEvent(baseTs); // same timestamp
    const result = strategy.tryCorrelate(newEvent, groups);
    expect(result).toBe('g1');
  });

  // -- Uses latest timestamp in group --

  it('uses latest event timestamp in group for window calculation', () => {
    const baseTs = 1700000000000;
    const groups = new Map<string, CorrelationGroup>();
    const event1 = makeEvent(baseTs);
    const event2 = makeEvent(baseTs + 4000); // latest event in group
    groups.set('g1', makeGroup([event1, event2], baseTs, 'g1'));

    // 3s after the latest event (within window), 7s after first event
    const newEvent = makeEvent(baseTs + 7000);
    const result = strategy.tryCorrelate(newEvent, groups);
    expect(result).toBe('g1');
  });

  it('does not correlate when gap from latest event exceeds window', () => {
    const baseTs = 1700000000000;
    const groups = new Map<string, CorrelationGroup>();
    const event1 = makeEvent(baseTs);
    const event2 = makeEvent(baseTs + 4000);
    groups.set('g1', makeGroup([event1, event2], baseTs, 'g1'));

    // 6s after the latest event (outside window)
    const newEvent = makeEvent(baseTs + 10001);
    const result = strategy.tryCorrelate(newEvent, groups);
    expect(result).toBeNull();
  });

  // -- Uses createdAt as fallback --

  it('uses createdAt when group has no events', () => {
    const baseTs = 1700000000000;
    const groups = new Map<string, CorrelationGroup>();
    groups.set('g1', makeGroup([], baseTs, 'g1'));

    const newEvent = makeEvent(baseTs + 2000);
    const result = strategy.tryCorrelate(newEvent, groups);
    expect(result).toBe('g1');
  });

  // -- Browser click/navigation act as triggers --

  it('returns null for browser click events (trigger events)', () => {
    const baseTs = 1700000000000;
    const groups = new Map<string, CorrelationGroup>();
    const existingEvent = makeEvent(baseTs);
    groups.set('g1', makeGroup([existingEvent], baseTs, 'g1'));

    const clickEvent = makeBrowserClickEvent(baseTs + 100);
    const result = strategy.tryCorrelate(clickEvent, groups);
    expect(result).toBeNull();
  });

  it('returns null for browser navigation events (trigger events)', () => {
    const baseTs = 1700000000000;
    const groups = new Map<string, CorrelationGroup>();
    const existingEvent = makeEvent(baseTs);
    groups.set('g1', makeGroup([existingEvent], baseTs, 'g1'));

    const navEvent = makeBrowserNavEvent(baseTs + 100);
    const result = strategy.tryCorrelate(navEvent, groups);
    expect(result).toBeNull();
  });

  it('correlates non-trigger browser events (e.g., console)', () => {
    const baseTs = 1700000000000;
    const groups = new Map<string, CorrelationGroup>();
    const existingEvent = makeEvent(baseTs);
    groups.set('g1', makeGroup([existingEvent], baseTs, 'g1'));

    const consoleEvent = makeBrowserConsoleEvent(baseTs + 100);
    const result = strategy.tryCorrelate(consoleEvent, groups);
    expect(result).toBe('g1');
  });

  // -- Multiple groups: picks closest --

  it('picks the group with the smallest temporal gap', () => {
    const baseTs = 1700000000000;
    const groups = new Map<string, CorrelationGroup>();
    const event1 = makeEvent(baseTs);
    const event2 = makeEvent(baseTs + 3000);
    groups.set('g1', makeGroup([event1], baseTs, 'g1'));
    groups.set('g2', makeGroup([event2], baseTs + 3000, 'g2'));

    // Event at baseTs + 3500 is 3500ms from g1, 500ms from g2
    const newEvent = makeEvent(baseTs + 3500);
    const result = strategy.tryCorrelate(newEvent, groups);
    expect(result).toBe('g2');
  });

  it('falls back to first valid group when equidistant', () => {
    const baseTs = 1700000000000;
    const groups = new Map<string, CorrelationGroup>();
    const event1 = makeEvent(baseTs);
    const event2 = makeEvent(baseTs);
    groups.set('g1', makeGroup([event1], baseTs, 'g1'));
    groups.set('g2', makeGroup([event2], baseTs, 'g2'));

    const newEvent = makeEvent(baseTs + 1000);
    const result = strategy.tryCorrelate(newEvent, groups);
    // Both have same gap, should pick first seen
    expect(result).toBe('g1');
  });

  // -- Multiple time windows forming separate groups --

  it('correctly identifies separate temporal windows', () => {
    const baseTs = 1700000000000;
    const groups = new Map<string, CorrelationGroup>();

    // Group 1: events around t=0
    const g1Event = makeEvent(baseTs);
    groups.set('g1', makeGroup([g1Event], baseTs, 'g1'));

    // Group 2: events around t=20s (well outside window of g1)
    const g2Event = makeEvent(baseTs + 20000);
    groups.set('g2', makeGroup([g2Event], baseTs + 20000, 'g2'));

    // Event close to g2 but far from g1
    const newEvent = makeEvent(baseTs + 21000);
    const result = strategy.tryCorrelate(newEvent, groups);
    expect(result).toBe('g2');
  });

  // -- Past events (negative gap) --

  it('does not correlate events with timestamp before group latest', () => {
    const baseTs = 1700000000000;
    const groups = new Map<string, CorrelationGroup>();
    const existingEvent = makeEvent(baseTs + 5000);
    groups.set('g1', makeGroup([existingEvent], baseTs, 'g1'));

    // Event is before the group's latest event
    const pastEvent = makeEvent(baseTs + 3000);
    const result = strategy.tryCorrelate(pastEvent, groups);
    // gap = 3000 - 5000 = -2000, negative gap should not match
    expect(result).toBeNull();
  });

  // -- No groups --

  it('returns null when no groups exist', () => {
    const groups = new Map<string, CorrelationGroup>();
    const event = makeEvent(1700000001000);
    const result = strategy.tryCorrelate(event, groups);
    expect(result).toBeNull();
  });

  // -- Different window sizes --

  it('works with a different window size', () => {
    const narrowStrategy = new TemporalStrategy(1000); // 1s window
    const baseTs = 1700000000000;
    const groups = new Map<string, CorrelationGroup>();
    const existingEvent = makeEvent(baseTs);
    groups.set('g1', makeGroup([existingEvent], baseTs, 'g1'));

    // 500ms - within 1s window
    expect(narrowStrategy.tryCorrelate(makeEvent(baseTs + 500), groups)).toBe('g1');
    // 1500ms - outside 1s window
    expect(narrowStrategy.tryCorrelate(makeEvent(baseTs + 1500), groups)).toBeNull();
  });

  it('works with very large window', () => {
    const wideStrategy = new TemporalStrategy(60000); // 60s window
    const baseTs = 1700000000000;
    const groups = new Map<string, CorrelationGroup>();
    const existingEvent = makeEvent(baseTs);
    groups.set('g1', makeGroup([existingEvent], baseTs, 'g1'));

    expect(wideStrategy.tryCorrelate(makeEvent(baseTs + 50000), groups)).toBe('g1');
    expect(wideStrategy.tryCorrelate(makeEvent(baseTs + 61000), groups)).toBeNull();
  });

  // -- Non-browser events always eligible --

  it('correlates log events within window', () => {
    const baseTs = 1700000000000;
    const groups = new Map<string, CorrelationGroup>();
    const existingEvent = makeEvent(baseTs);
    groups.set('g1', makeGroup([existingEvent], baseTs, 'g1'));

    const logEvent = makeEvent(baseTs + 1000, 'log');
    const result = strategy.tryCorrelate(logEvent, groups);
    expect(result).toBe('g1');
  });

  it('correlates network events within window', () => {
    const baseTs = 1700000000000;
    const groups = new Map<string, CorrelationGroup>();
    const existingEvent = makeEvent(baseTs);
    groups.set('g1', makeGroup([existingEvent], baseTs, 'g1'));

    const networkEvent = makeEvent(baseTs + 2000, 'network');
    const result = strategy.tryCorrelate(networkEvent, groups);
    expect(result).toBe('g1');
  });
});
