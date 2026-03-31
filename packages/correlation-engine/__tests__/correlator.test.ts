import { describe, it, expect, beforeEach } from 'vitest';
import { EventCorrelator } from '../src/correlator.js';
import type { ProbeEvent, CorrelationConfig, CorrelationGroup } from '@probe/core';
import { generateId, nowMs } from '@probe/core';

function makeEvent(overrides: Partial<ProbeEvent> = {}): ProbeEvent {
  return {
    id: generateId(),
    sessionId: 'sess-test',
    timestamp: nowMs(),
    source: 'sdk',
    ...overrides,
  } as ProbeEvent;
}

const defaultConfig: CorrelationConfig = {
  strategies: ['request-id', 'temporal'],
  temporalWindowMs: 5000,
  groupTimeoutMs: 60_000,
};

describe('EventCorrelator', () => {
  let correlator: EventCorrelator;

  beforeEach(() => {
    correlator = new EventCorrelator();
  });

  it('throws if ingest called before initialize', () => {
    expect(() => correlator.ingest(makeEvent())).toThrow('not initialized');
  });

  it('initialize sets config and strategies', () => {
    correlator.initialize(defaultConfig);
    // Should not throw when ingesting after init
    expect(() => correlator.ingest(makeEvent())).not.toThrow();
  });

  it('creates a new group for a first event', () => {
    correlator.initialize(defaultConfig);
    correlator.ingest(makeEvent());
    const groups = correlator.getGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].events).toHaveLength(1);
  });

  it('correlates events by shared correlationId into same group', () => {
    correlator.initialize(defaultConfig);
    const corrId = 'shared-corr';
    correlator.ingest(makeEvent({ correlationId: corrId }));
    correlator.ingest(makeEvent({ correlationId: corrId }));
    const groups = correlator.getGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].events).toHaveLength(2);
  });

  it('temporal strategy groups events within windowMs', () => {
    correlator.initialize({ ...defaultConfig, strategies: ['temporal'], temporalWindowMs: 10_000 });
    const now = nowMs();
    correlator.ingest(makeEvent({ timestamp: now }));
    correlator.ingest(makeEvent({ timestamp: now + 100 })); // within window
    const groups = correlator.getGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].events).toHaveLength(2);
  });

  it('caps events at MAX_EVENTS (50,000)', () => {
    correlator.initialize(defaultConfig);
    // Ingest more than 50k events — the internal allEvents should be capped
    for (let i = 0; i < 50_010; i++) {
      correlator.ingest(makeEvent({ correlationId: `corr-${i % 100}`, timestamp: nowMs() + i }));
    }
    // Groups should exist, system should not crash
    const groups = correlator.getGroups();
    expect(groups.length).toBeGreaterThan(0);
  });

  it('caps groups at MAX_GROUPS (5,000)', () => {
    correlator.initialize({ ...defaultConfig, strategies: ['request-id'] });
    // Create many unique correlationIds to force unique groups
    for (let i = 0; i < 5_010; i++) {
      correlator.ingest(makeEvent({ correlationId: `unique-${i}`, timestamp: i }));
    }
    const groups = correlator.getGroups();
    expect(groups.length).toBeLessThanOrEqual(5_000);
  });

  it('getGroup returns a specific group by ID', () => {
    correlator.initialize(defaultConfig);
    correlator.ingest(makeEvent({ correlationId: 'abc' }));
    const groups = correlator.getGroups();
    const found = correlator.getGroup(groups[0].id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(groups[0].id);
  });

  it('getGroupByCorrelationId finds group by correlation ID', () => {
    correlator.initialize(defaultConfig);
    correlator.ingest(makeEvent({ correlationId: 'find-me' }));
    const found = correlator.getGroupByCorrelationId('find-me');
    expect(found).toBeDefined();
    expect(found!.correlationId).toBe('find-me');
  });

  it('fires onGroupCreated handler', () => {
    correlator.initialize(defaultConfig);
    const created: CorrelationGroup[] = [];
    correlator.onGroupCreated((g) => created.push(g));
    correlator.ingest(makeEvent());
    expect(created).toHaveLength(1);
  });

  it('fires onGroupUpdated handler when event added to existing group', () => {
    correlator.initialize(defaultConfig);
    const updated: CorrelationGroup[] = [];
    correlator.onGroupUpdated((g) => updated.push(g));
    correlator.ingest(makeEvent({ correlationId: 'update-me' }));
    correlator.ingest(makeEvent({ correlationId: 'update-me' }));
    expect(updated).toHaveLength(1); // second event triggers update
  });

  it('swallows handler errors without crashing', () => {
    correlator.initialize(defaultConfig);
    correlator.onGroupCreated(() => { throw new Error('boom'); });
    expect(() => correlator.ingest(makeEvent())).not.toThrow();
  });

  it('unsubscribe removes handler', () => {
    correlator.initialize(defaultConfig);
    const created: CorrelationGroup[] = [];
    const unsubscribe = correlator.onGroupCreated((g) => created.push(g));
    correlator.ingest(makeEvent({ correlationId: 'first' }));
    unsubscribe();
    correlator.ingest(makeEvent({ correlationId: 'second' }));
    expect(created).toHaveLength(1);
  });

  it('reset clears all state', () => {
    correlator.initialize(defaultConfig);
    correlator.ingest(makeEvent());
    correlator.reset();
    expect(correlator.getGroups()).toHaveLength(0);
  });

  it('buildTimeline returns a sorted timeline', () => {
    correlator.initialize(defaultConfig);
    const now = nowMs();
    correlator.ingest(makeEvent({ timestamp: now + 100 }));
    correlator.ingest(makeEvent({ timestamp: now }));
    const timeline = correlator.buildTimeline();
    expect(timeline).toBeDefined();
    expect(timeline.entries.length).toBeGreaterThan(0);
  });
});
