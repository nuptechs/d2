import { describe, it, expect, beforeEach } from 'vitest';
import { RequestIdStrategy } from '../../src/strategies/request-id.strategy.js';
import type {
  ProbeEvent,
  CorrelationGroup,
  CorrelationSummary,
  NetworkEvent,
  LogEvent,
  SdkEvent,
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
  id = `group-${uid()}`,
  correlationId = '',
): CorrelationGroup {
  return {
    id,
    sessionId: 'sess-test',
    correlationId,
    createdAt: 1700000000000,
    events,
    summary: makeSummary(),
  };
}

function makeNetworkEvent(
  requestId: string,
  type: 'request' | 'response' = 'request',
  overrides: Record<string, unknown> = {},
): NetworkEvent {
  return {
    id: uid(),
    sessionId: 'sess-test',
    timestamp: 1700000001000,
    source: 'network',
    type,
    requestId,
    ...overrides,
  } as NetworkEvent;
}

function makeSdkEvent(requestId?: string, overrides: Record<string, unknown> = {}): SdkEvent {
  return {
    id: uid(),
    sessionId: 'sess-test',
    timestamp: 1700000001000,
    source: 'sdk',
    type: 'request-start',
    ...(requestId && { requestId }),
    ...overrides,
  } as SdkEvent & { requestId?: string };
}

function makeLogEvent(structured?: Record<string, unknown>, overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    id: uid(),
    sessionId: 'sess-test',
    timestamp: 1700000001000,
    source: 'log',
    level: 'info',
    message: 'test log',
    rawLine: 'test log',
    logSource: { type: 'stdout', name: 'app' },
    ...(structured && { structured }),
    ...overrides,
  } as LogEvent;
}

function makeBaseEvent(correlationId?: string): ProbeEvent {
  return {
    id: uid(),
    sessionId: 'sess-test',
    timestamp: 1700000001000,
    source: 'sdk',
    type: 'custom',
    ...(correlationId && { correlationId }),
  };
}

// ---- Tests ----

describe('RequestIdStrategy', () => {
  let strategy: RequestIdStrategy;

  beforeEach(() => {
    strategy = new RequestIdStrategy();
    idCounter = 0;
  });

  it('returns request-id as name', () => {
    expect(strategy.getName()).toBe('request-id');
  });

  // -- correlationId on event --

  it('matches events by shared correlationId', () => {
    const groups = new Map<string, CorrelationGroup>();
    const existing = makeBaseEvent('corr-abc');
    groups.set('g1', makeGroup([existing], 'g1'));

    const newEvent = makeBaseEvent('corr-abc');
    const result = strategy.tryCorrelate(newEvent, groups);
    expect(result).toBe('g1');
  });

  it('matches when group has correlationId set', () => {
    const groups = new Map<string, CorrelationGroup>();
    groups.set('g1', makeGroup([], 'g1', 'corr-abc'));

    const newEvent = makeBaseEvent('corr-abc');
    const result = strategy.tryCorrelate(newEvent, groups);
    expect(result).toBe('g1');
  });

  it('returns null when correlationIds differ', () => {
    const groups = new Map<string, CorrelationGroup>();
    const existing = makeBaseEvent('corr-abc');
    groups.set('g1', makeGroup([existing], 'g1'));

    const newEvent = makeBaseEvent('corr-xyz');
    const result = strategy.tryCorrelate(newEvent, groups);
    expect(result).toBeNull();
  });

  // -- Network event requestId --

  it('correlates network events by requestId', () => {
    const groups = new Map<string, CorrelationGroup>();
    const req = makeNetworkEvent('req-123', 'request');
    groups.set('g1', makeGroup([req], 'g1'));

    const res = makeNetworkEvent('req-123', 'response');
    const result = strategy.tryCorrelate(res, groups);
    expect(result).toBe('g1');
  });

  it('does not correlate network events with different requestIds', () => {
    const groups = new Map<string, CorrelationGroup>();
    const req = makeNetworkEvent('req-123', 'request');
    groups.set('g1', makeGroup([req], 'g1'));

    const res = makeNetworkEvent('req-456', 'response');
    const result = strategy.tryCorrelate(res, groups);
    expect(result).toBeNull();
  });

  // -- SDK event requestId --

  it('correlates SDK events by requestId', () => {
    const groups = new Map<string, CorrelationGroup>();
    const req = makeNetworkEvent('req-sdk-1', 'request');
    groups.set('g1', makeGroup([req], 'g1'));

    const sdkEvent = makeSdkEvent('req-sdk-1');
    const result = strategy.tryCorrelate(sdkEvent, groups);
    expect(result).toBe('g1');
  });

  it('returns null for SDK event without requestId', () => {
    const groups = new Map<string, CorrelationGroup>();
    const req = makeNetworkEvent('req-123', 'request');
    groups.set('g1', makeGroup([req], 'g1'));

    const sdkEvent = makeSdkEvent(undefined);
    const result = strategy.tryCorrelate(sdkEvent, groups);
    expect(result).toBeNull();
  });

  // -- Log event structured fields --

  it('extracts correlationId from log structured data', () => {
    const groups = new Map<string, CorrelationGroup>();
    const existing = makeBaseEvent('corr-log-1');
    groups.set('g1', makeGroup([existing], 'g1'));

    const log = makeLogEvent({ correlationId: 'corr-log-1' });
    const result = strategy.tryCorrelate(log, groups);
    expect(result).toBe('g1');
  });

  it('extracts correlation_id (snake_case) from log structured data', () => {
    const groups = new Map<string, CorrelationGroup>();
    const existing = makeBaseEvent('corr-snake');
    groups.set('g1', makeGroup([existing], 'g1'));

    const log = makeLogEvent({ correlation_id: 'corr-snake' });
    const result = strategy.tryCorrelate(log, groups);
    expect(result).toBe('g1');
  });

  it('extracts requestId from log structured data', () => {
    const groups = new Map<string, CorrelationGroup>();
    const req = makeNetworkEvent('req-from-log', 'request');
    groups.set('g1', makeGroup([req], 'g1'));

    const log = makeLogEvent({ requestId: 'req-from-log' });
    const result = strategy.tryCorrelate(log, groups);
    expect(result).toBe('g1');
  });

  it('extracts request_id (snake_case) from log structured data', () => {
    const groups = new Map<string, CorrelationGroup>();
    const req = makeNetworkEvent('req-snake', 'request');
    groups.set('g1', makeGroup([req], 'g1'));

    const log = makeLogEvent({ request_id: 'req-snake' });
    const result = strategy.tryCorrelate(log, groups);
    expect(result).toBe('g1');
  });

  it('extracts traceId from log structured data', () => {
    const groups = new Map<string, CorrelationGroup>();
    const existing = makeBaseEvent('trace-abc');
    groups.set('g1', makeGroup([existing], 'g1'));

    const log = makeLogEvent({ traceId: 'trace-abc' });
    const result = strategy.tryCorrelate(log, groups);
    expect(result).toBe('g1');
  });

  it('extracts trace_id (snake_case) from log structured data', () => {
    const groups = new Map<string, CorrelationGroup>();
    const existing = makeBaseEvent('trace-snake');
    groups.set('g1', makeGroup([existing], 'g1'));

    const log = makeLogEvent({ trace_id: 'trace-snake' });
    const result = strategy.tryCorrelate(log, groups);
    expect(result).toBe('g1');
  });

  it('returns null for log without structured data', () => {
    const groups = new Map<string, CorrelationGroup>();
    const existing = makeBaseEvent('corr-1');
    groups.set('g1', makeGroup([existing], 'g1'));

    const log = makeLogEvent(undefined);
    const result = strategy.tryCorrelate(log, groups);
    expect(result).toBeNull();
  });

  it('returns null for log with structured data but no correlation fields', () => {
    const groups = new Map<string, CorrelationGroup>();
    const existing = makeBaseEvent('corr-1');
    groups.set('g1', makeGroup([existing], 'g1'));

    const log = makeLogEvent({ level: 'info', timestamp: 123 });
    const result = strategy.tryCorrelate(log, groups);
    expect(result).toBeNull();
  });

  it('ignores non-string correlation values in structured data', () => {
    const groups = new Map<string, CorrelationGroup>();
    const existing = makeBaseEvent('123');
    groups.set('g1', makeGroup([existing], 'g1'));

    const log = makeLogEvent({ correlationId: 123 });
    const result = strategy.tryCorrelate(log, groups);
    expect(result).toBeNull();
  });

  // -- No match / empty groups --

  it('returns null when no groups exist', () => {
    const groups = new Map<string, CorrelationGroup>();
    const event = makeBaseEvent('corr-lonely');
    const result = strategy.tryCorrelate(event, groups);
    expect(result).toBeNull();
  });

  it('returns null for event with no correlation key at all', () => {
    const groups = new Map<string, CorrelationGroup>();
    const existing = makeBaseEvent('corr-1');
    groups.set('g1', makeGroup([existing], 'g1'));

    const event: ProbeEvent = {
      id: uid(),
      sessionId: 'sess-test',
      timestamp: 1700000001000,
      source: 'browser',
      type: 'click',
    };
    const result = strategy.tryCorrelate(event, groups);
    expect(result).toBeNull();
  });

  // -- Priority: correlationId on event takes precedence --

  it('prefers event correlationId over other extraction methods', () => {
    const groups = new Map<string, CorrelationGroup>();
    const existing = makeBaseEvent('corr-event');
    groups.set('g1', makeGroup([existing], 'g1'));

    // Event has both correlationId and is a network event
    const networkEvent: ProbeEvent = {
      id: uid(),
      sessionId: 'sess-test',
      timestamp: 1700000001000,
      source: 'network',
      type: 'request',
      correlationId: 'corr-event',
    };
    const result = strategy.tryCorrelate(networkEvent, groups);
    expect(result).toBe('g1');
  });

  // -- Multiple groups --

  it('finds correct group among multiple groups', () => {
    const groups = new Map<string, CorrelationGroup>();
    groups.set('g1', makeGroup([makeBaseEvent('corr-aaa')], 'g1'));
    groups.set('g2', makeGroup([makeBaseEvent('corr-bbb')], 'g2'));
    groups.set('g3', makeGroup([makeBaseEvent('corr-ccc')], 'g3'));

    const event = makeBaseEvent('corr-bbb');
    const result = strategy.tryCorrelate(event, groups);
    expect(result).toBe('g2');
  });
});
