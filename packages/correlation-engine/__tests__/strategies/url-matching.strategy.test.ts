import { describe, it, expect, beforeEach } from 'vitest';
import { UrlMatchingStrategy } from '../../src/strategies/url-matching.strategy.js';
import type {
  ProbeEvent,
  CorrelationGroup,
  CorrelationSummary,
  RequestEvent,
  NavigationEvent,
  BrowserEvent,
  LogEvent,
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

function makeGroup(events: ProbeEvent[], id = `group-${uid()}`): CorrelationGroup {
  return {
    id,
    sessionId: 'sess-test',
    correlationId: '',
    createdAt: 1700000000000,
    events,
    summary: makeSummary(),
  };
}

function makeRequestEvent(url: string, overrides: Partial<RequestEvent> = {}): RequestEvent {
  return {
    id: uid(),
    sessionId: 'sess-test',
    timestamp: 1700000001000,
    source: 'network',
    type: 'request',
    requestId: uid(),
    method: 'GET',
    url,
    headers: {},
    ...overrides,
  } as RequestEvent;
}

function makeNavigationEvent(toUrl: string): NavigationEvent {
  return {
    id: uid(),
    sessionId: 'sess-test',
    timestamp: 1700000001000,
    source: 'browser',
    type: 'navigation',
    pageUrl: 'https://app.example.com',
    toUrl,
  } as NavigationEvent;
}

function makeBrowserEvent(pageUrl: string, overrides: Partial<BrowserEvent> = {}): BrowserEvent {
  return {
    id: uid(),
    sessionId: 'sess-test',
    timestamp: 1700000001000,
    source: 'browser',
    type: 'click',
    pageUrl,
    ...overrides,
  } as BrowserEvent;
}

function makeLogEvent(message: string): LogEvent {
  return {
    id: uid(),
    sessionId: 'sess-test',
    timestamp: 1700000001000,
    source: 'log',
    level: 'info',
    message,
    rawLine: message,
    logSource: { type: 'stdout', name: 'app' },
  } as LogEvent;
}

function makeSdkEvent(): ProbeEvent {
  return {
    id: uid(),
    sessionId: 'sess-test',
    timestamp: 1700000001000,
    source: 'sdk',
    type: 'custom',
  };
}

// ---- Tests ----

describe('UrlMatchingStrategy', () => {
  let strategy: UrlMatchingStrategy;

  beforeEach(() => {
    strategy = new UrlMatchingStrategy();
    idCounter = 0;
  });

  it('returns url-matching as name', () => {
    expect(strategy.getName()).toBe('url-matching');
  });

  // -- URL extraction from request events --

  it('extracts URL from request events', () => {
    const groups = new Map<string, CorrelationGroup>();
    const reqInGroup = makeRequestEvent('https://api.example.com/users');
    groups.set('g1', makeGroup([reqInGroup], 'g1'));

    const newReq = makeRequestEvent('https://api.example.com/users');
    const result = strategy.tryCorrelate(newReq, groups);
    expect(result).toBe('g1');
  });

  // -- URL extraction from navigation events --

  it('extracts toUrl from navigation events', () => {
    const groups = new Map<string, CorrelationGroup>();
    const navInGroup = makeNavigationEvent('https://app.example.com/dashboard');
    groups.set('g1', makeGroup([navInGroup], 'g1'));

    const newNav = makeNavigationEvent('https://app.example.com/dashboard');
    const result = strategy.tryCorrelate(newNav, groups);
    expect(result).toBe('g1');
  });

  // -- URL extraction from browser events (pageUrl) --

  it('extracts pageUrl from browser click events', () => {
    const groups = new Map<string, CorrelationGroup>();
    const clickInGroup = makeBrowserEvent('https://app.example.com/page');
    groups.set('g1', makeGroup([clickInGroup], 'g1'));

    const newClick = makeBrowserEvent('https://app.example.com/page');
    const result = strategy.tryCorrelate(newClick, groups);
    expect(result).toBe('g1');
  });

  // -- URL extraction from log messages --

  it('extracts URL from log message text', () => {
    const groups = new Map<string, CorrelationGroup>();
    const reqInGroup = makeRequestEvent('https://api.example.com/orders');
    groups.set('g1', makeGroup([reqInGroup], 'g1'));

    const log = makeLogEvent('Request to https://api.example.com/orders failed with 500');
    const result = strategy.tryCorrelate(log, groups);
    expect(result).toBe('g1');
  });

  it('returns null for log with no URL in message', () => {
    const groups = new Map<string, CorrelationGroup>();
    const reqInGroup = makeRequestEvent('https://api.example.com/users');
    groups.set('g1', makeGroup([reqInGroup], 'g1'));

    const log = makeLogEvent('No URL in this message at all');
    const result = strategy.tryCorrelate(log, groups);
    expect(result).toBeNull();
  });

  // -- URL normalization --

  it('normalizes URLs by stripping query params', () => {
    const groups = new Map<string, CorrelationGroup>();
    const reqInGroup = makeRequestEvent('https://api.example.com/users?page=1');
    groups.set('g1', makeGroup([reqInGroup], 'g1'));

    const newReq = makeRequestEvent('https://api.example.com/users?page=2&limit=10');
    const result = strategy.tryCorrelate(newReq, groups);
    expect(result).toBe('g1');
  });

  it('normalizes URLs by stripping trailing slash', () => {
    const groups = new Map<string, CorrelationGroup>();
    const reqInGroup = makeRequestEvent('https://api.example.com/users/');
    groups.set('g1', makeGroup([reqInGroup], 'g1'));

    const newReq = makeRequestEvent('https://api.example.com/users');
    const result = strategy.tryCorrelate(newReq, groups);
    expect(result).toBe('g1');
  });

  it('normalizes URLs case-insensitively', () => {
    const groups = new Map<string, CorrelationGroup>();
    const reqInGroup = makeRequestEvent('https://API.Example.COM/Users');
    groups.set('g1', makeGroup([reqInGroup], 'g1'));

    const newReq = makeRequestEvent('https://api.example.com/users');
    const result = strategy.tryCorrelate(newReq, groups);
    expect(result).toBe('g1');
  });

  it('normalizes by stripping hash fragments', () => {
    const groups = new Map<string, CorrelationGroup>();
    const reqInGroup = makeRequestEvent('https://app.example.com/page#section1');
    groups.set('g1', makeGroup([reqInGroup], 'g1'));

    const newReq = makeRequestEvent('https://app.example.com/page#section2');
    const result = strategy.tryCorrelate(newReq, groups);
    expect(result).toBe('g1');
  });

  // -- No match cases --

  it('returns null when no groups exist', () => {
    const groups = new Map<string, CorrelationGroup>();
    const req = makeRequestEvent('https://api.example.com/data');
    const result = strategy.tryCorrelate(req, groups);
    expect(result).toBeNull();
  });

  it('returns null when URLs differ', () => {
    const groups = new Map<string, CorrelationGroup>();
    const reqInGroup = makeRequestEvent('https://api.example.com/users');
    groups.set('g1', makeGroup([reqInGroup], 'g1'));

    const newReq = makeRequestEvent('https://api.example.com/orders');
    const result = strategy.tryCorrelate(newReq, groups);
    expect(result).toBeNull();
  });

  it('returns null for events with no extractable URL', () => {
    const groups = new Map<string, CorrelationGroup>();
    const reqInGroup = makeRequestEvent('https://api.example.com/data');
    groups.set('g1', makeGroup([reqInGroup], 'g1'));

    const sdkEvent = makeSdkEvent();
    const result = strategy.tryCorrelate(sdkEvent, groups);
    expect(result).toBeNull();
  });

  // -- 2KB cap on log message search --

  it('caps URL search to first 2KB of log message', () => {
    const groups = new Map<string, CorrelationGroup>();
    const reqInGroup = makeRequestEvent('https://api.example.com/data');
    groups.set('g1', makeGroup([reqInGroup], 'g1'));

    // URL is beyond 2KB mark
    const padding = 'x'.repeat(2100);
    const log = makeLogEvent(`${padding} https://api.example.com/data`);
    const result = strategy.tryCorrelate(log, groups);
    expect(result).toBeNull();
  });

  it('finds URL within first 2KB of log message', () => {
    const groups = new Map<string, CorrelationGroup>();
    const reqInGroup = makeRequestEvent('https://api.example.com/data');
    groups.set('g1', makeGroup([reqInGroup], 'g1'));

    const log = makeLogEvent('Request to https://api.example.com/data succeeded');
    const result = strategy.tryCorrelate(log, groups);
    expect(result).toBe('g1');
  });

  // -- Multiple URLs / multiple groups --

  it('matches against the first matching group', () => {
    const groups = new Map<string, CorrelationGroup>();
    const req1 = makeRequestEvent('https://api.example.com/users');
    const req2 = makeRequestEvent('https://api.example.com/orders');
    groups.set('g1', makeGroup([req1], 'g1'));
    groups.set('g2', makeGroup([req2], 'g2'));

    const newReq = makeRequestEvent('https://api.example.com/orders');
    const result = strategy.tryCorrelate(newReq, groups);
    expect(result).toBe('g2');
  });

  // -- Malformed / edge case URLs --

  it('handles relative URL-like strings in normalization fallback', () => {
    const groups = new Map<string, CorrelationGroup>();
    // Log events might have non-absolute URLs extracted
    const log1 = makeLogEvent('Fetching from https://weird-url/path?x=1');
    const log2 = makeLogEvent('Also fetching https://weird-url/path?y=2');

    groups.set('g1', makeGroup([log1], 'g1'));
    const result = strategy.tryCorrelate(log2, groups);
    expect(result).toBe('g1');
  });

  it('handles response events (no URL) gracefully', () => {
    const groups = new Map<string, CorrelationGroup>();
    const reqInGroup = makeRequestEvent('https://api.example.com/data');
    groups.set('g1', makeGroup([reqInGroup], 'g1'));

    const responseEvent: ProbeEvent = {
      id: uid(),
      sessionId: 'sess-test',
      timestamp: 1700000002000,
      source: 'network',
      type: 'response',
    };
    const result = strategy.tryCorrelate(responseEvent, groups);
    expect(result).toBeNull();
  });

  it('does not match different paths on same host', () => {
    const groups = new Map<string, CorrelationGroup>();
    const reqInGroup = makeRequestEvent('https://api.example.com/v1/users');
    groups.set('g1', makeGroup([reqInGroup], 'g1'));

    const newReq = makeRequestEvent('https://api.example.com/v2/users');
    const result = strategy.tryCorrelate(newReq, groups);
    expect(result).toBeNull();
  });

  it('matches http and https separately', () => {
    const groups = new Map<string, CorrelationGroup>();
    const reqInGroup = makeRequestEvent('http://api.example.com/data');
    groups.set('g1', makeGroup([reqInGroup], 'g1'));

    const newReq = makeRequestEvent('https://api.example.com/data');
    const result = strategy.tryCorrelate(newReq, groups);
    // Different protocol = different normalized URL
    expect(result).toBeNull();
  });
});
