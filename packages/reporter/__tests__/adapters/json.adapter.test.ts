import { describe, it, expect, beforeEach } from 'vitest';
import { JsonReporter } from '../../src/adapters/json.adapter.js';
import type { ReportData, ReportOptions } from '@probe/core';
import type {
  ProbeEvent,
  RequestEvent,
  ResponseEvent,
  ScreenshotEvent,
  LogEvent,
  TimelineEntry,
  CorrelationGroup,
  CorrelationSummary,
} from '@probe/core';

// ---- Helpers ----

let idCounter = 0;
function uid(): string {
  return `test-id-${++idCounter}`;
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-json',
    name: 'JSON Test Session',
    status: 'completed' as const,
    startedAt: 1700000000000,
    endedAt: 1700000060000,
    eventCount: 5,
    config: {},
    tags: [],
    ...overrides,
  };
}

function makeTimeline(entries: TimelineEntry[] = [], statsOverrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-json',
    entries,
    duration: 60000,
    startTime: 1700000000000,
    endTime: 1700000060000,
    stats: {
      totalEvents: entries.length,
      bySource: { browser: 0, network: 0, log: 0, sdk: 0, correlation: 0 },
      correlationGroups: 0,
      errors: 0,
      ...statsOverrides,
    },
  };
}

function makeEntry(event: ProbeEvent, depth = 0, groupId?: string): TimelineEntry {
  return { event, depth, groupId };
}

function makeRequestEvent(overrides: Partial<RequestEvent> = {}): RequestEvent {
  return {
    id: uid(),
    sessionId: 'sess-json',
    timestamp: 1700000001000,
    source: 'network',
    type: 'request',
    requestId: 'req-1',
    method: 'GET',
    url: 'https://api.example.com/data',
    headers: {},
    body: '{"query":"test"}',
    ...overrides,
  } as RequestEvent;
}

function makeResponseEvent(overrides: Partial<ResponseEvent> = {}): ResponseEvent {
  return {
    id: uid(),
    sessionId: 'sess-json',
    timestamp: 1700000002000,
    source: 'network',
    type: 'response',
    requestId: 'req-1',
    statusCode: 200,
    statusText: 'OK',
    headers: {},
    body: '{"result":"ok"}',
    duration: 150,
    ...overrides,
  } as ResponseEvent;
}

function makeScreenshotEvent(overrides: Partial<ScreenshotEvent> = {}): ScreenshotEvent {
  return {
    id: uid(),
    sessionId: 'sess-json',
    timestamp: 1700000002000,
    source: 'browser',
    type: 'screenshot',
    pageUrl: 'https://app.example.com',
    data: 'base64screenshotdata==',
    viewport: { width: 1920, height: 1080 },
    trigger: 'manual',
    label: 'Test Screenshot',
    ...overrides,
  } as ScreenshotEvent;
}

function makeSummary(overrides: Partial<CorrelationSummary> = {}): CorrelationSummary {
  return {
    trigger: 'click',
    hasScreenshot: false,
    hasError: false,
    errorMessages: [],
    logCount: 0,
    dbQueryCount: 0,
    dbTotalDuration: 0,
    entitiesInvolved: [],
    ...overrides,
  };
}

function makeCorrelationGroup(events: ProbeEvent[] = [], overrides: Partial<CorrelationGroup> = {}): CorrelationGroup {
  return {
    id: 'group-json-1',
    sessionId: 'sess-json',
    correlationId: 'corr-1',
    createdAt: 1700000000000,
    events,
    summary: makeSummary(),
    ...overrides,
  };
}

function makeData(overrides: Partial<ReportData> = {}): ReportData {
  return {
    session: makeSession(),
    timeline: makeTimeline(),
    correlationGroups: [],
    ...overrides,
  };
}

// ---- Tests ----

describe('JsonReporter', () => {
  let reporter: JsonReporter;

  beforeEach(() => {
    reporter = new JsonReporter();
    idCounter = 0;
  });

  // -- Format metadata --

  it('returns json format', () => {
    expect(reporter.getFormat()).toBe('json');
  });

  it('returns application/json mime type', () => {
    expect(reporter.getMimeType()).toBe('application/json');
  });

  it('returns json file extension', () => {
    expect(reporter.getFileExtension()).toBe('json');
  });

  // -- Output structure --

  it('generates valid JSON string', async () => {
    const output = await reporter.generate(makeData());
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it('output contains session, timeline, and correlationGroups', async () => {
    const output = await reporter.generate(makeData());
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('session');
    expect(parsed).toHaveProperty('timeline');
    expect(parsed).toHaveProperty('correlationGroups');
  });

  it('session data is preserved correctly', async () => {
    const output = await reporter.generate(makeData());
    const parsed = JSON.parse(output);
    expect(parsed.session.id).toBe('sess-json');
    expect(parsed.session.name).toBe('JSON Test Session');
    expect(parsed.session.status).toBe('completed');
    expect(parsed.session.startedAt).toBe(1700000000000);
  });

  it('timeline entries are included', async () => {
    const event: ProbeEvent = {
      id: uid(), sessionId: 'sess-json', timestamp: 1700000001000, source: 'sdk', type: 'custom',
    };
    const data = makeData({ timeline: makeTimeline([makeEntry(event)]) });
    const output = await reporter.generate(data);
    const parsed = JSON.parse(output);
    expect(parsed.timeline.entries).toHaveLength(1);
    expect(parsed.timeline.entries[0].event.source).toBe('sdk');
  });

  it('timeline stats are included', async () => {
    const data = makeData({
      timeline: makeTimeline([], { totalEvents: 42, errors: 3 }),
    });
    const output = await reporter.generate(data);
    const parsed = JSON.parse(output);
    expect(parsed.timeline.stats.totalEvents).toBe(42);
    expect(parsed.timeline.stats.errors).toBe(3);
  });

  it('correlation groups are included', async () => {
    const event: ProbeEvent = {
      id: uid(), sessionId: 'sess-json', timestamp: 1700000001000, source: 'sdk',
    };
    const group = makeCorrelationGroup([event]);
    const data = makeData({ correlationGroups: [group] });
    const output = await reporter.generate(data);
    const parsed = JSON.parse(output);
    expect(parsed.correlationGroups).toHaveLength(1);
    expect(parsed.correlationGroups[0].id).toBe('group-json-1');
    expect(parsed.correlationGroups[0].events).toHaveLength(1);
  });

  it('generates pretty-printed JSON (2 space indent)', async () => {
    const output = await reporter.generate(makeData());
    // Pretty-printed JSON has newlines and indentation
    expect(output).toContain('\n');
    expect(output).toContain('  ');
  });

  // -- Screenshot filtering --

  it('omits screenshot data when includeScreenshots is false', async () => {
    const ss = makeScreenshotEvent();
    const data = makeData({ timeline: makeTimeline([makeEntry(ss)]) });
    const output = await reporter.generate(data, { includeScreenshots: false });
    const parsed = JSON.parse(output);
    const event = parsed.timeline.entries[0].event;
    expect(event.data).toBe('[screenshot omitted]');
  });

  it('preserves screenshot data when includeScreenshots is true', async () => {
    const ss = makeScreenshotEvent();
    const data = makeData({ timeline: makeTimeline([makeEntry(ss)]) });
    const output = await reporter.generate(data, { includeScreenshots: true });
    const parsed = JSON.parse(output);
    const event = parsed.timeline.entries[0].event;
    expect(event.data).toBe('base64screenshotdata==');
  });

  it('preserves screenshot data when no options given', async () => {
    const ss = makeScreenshotEvent();
    const data = makeData({ timeline: makeTimeline([makeEntry(ss)]) });
    const output = await reporter.generate(data);
    const parsed = JSON.parse(output);
    const event = parsed.timeline.entries[0].event;
    expect(event.data).toBe('base64screenshotdata==');
  });

  // -- Request body filtering --

  it('strips request body when includeRequestBodies is false', async () => {
    const req = makeRequestEvent();
    const data = makeData({ timeline: makeTimeline([makeEntry(req)]) });
    const output = await reporter.generate(data, { includeRequestBodies: false });
    const parsed = JSON.parse(output);
    const event = parsed.timeline.entries[0].event;
    expect(event.body).toBeUndefined();
  });

  it('strips response body when includeRequestBodies is false', async () => {
    const res = makeResponseEvent();
    const data = makeData({ timeline: makeTimeline([makeEntry(res)]) });
    const output = await reporter.generate(data, { includeRequestBodies: false });
    const parsed = JSON.parse(output);
    const event = parsed.timeline.entries[0].event;
    expect(event.body).toBeUndefined();
  });

  it('preserves request/response bodies when includeRequestBodies is true', async () => {
    const req = makeRequestEvent();
    const res = makeResponseEvent();
    const data = makeData({ timeline: makeTimeline([makeEntry(req), makeEntry(res)]) });
    const output = await reporter.generate(data, { includeRequestBodies: true });
    const parsed = JSON.parse(output);
    expect(parsed.timeline.entries[0].event.body).toBe('{"query":"test"}');
    expect(parsed.timeline.entries[1].event.body).toBe('{"result":"ok"}');
  });

  // -- maxEventsPerGroup on correlation groups --

  it('caps events per correlation group with maxEventsPerGroup', async () => {
    const events: ProbeEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push({
        id: uid(), sessionId: 'sess-json', timestamp: 1700000000000 + i * 1000, source: 'sdk', type: 'custom',
      });
    }
    const group = makeCorrelationGroup(events);
    const data = makeData({ correlationGroups: [group] });
    const output = await reporter.generate(data, { maxEventsPerGroup: 3 });
    const parsed = JSON.parse(output);
    expect(parsed.correlationGroups[0].events).toHaveLength(3);
  });

  it('does not cap events when maxEventsPerGroup is not set', async () => {
    const events: ProbeEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push({
        id: uid(), sessionId: 'sess-json', timestamp: 1700000000000 + i * 1000, source: 'sdk', type: 'custom',
      });
    }
    const group = makeCorrelationGroup(events);
    const data = makeData({ correlationGroups: [group] });
    const output = await reporter.generate(data);
    const parsed = JSON.parse(output);
    expect(parsed.correlationGroups[0].events).toHaveLength(10);
  });

  // -- Combined filters --

  it('applies multiple filters simultaneously', async () => {
    const req = makeRequestEvent();
    const ss = makeScreenshotEvent();
    const data = makeData({
      timeline: makeTimeline([makeEntry(req), makeEntry(ss)]),
    });
    const output = await reporter.generate(data, {
      includeRequestBodies: false,
      includeScreenshots: false,
    });
    const parsed = JSON.parse(output);
    expect(parsed.timeline.entries[0].event.body).toBeUndefined();
    expect(parsed.timeline.entries[1].event.data).toBe('[screenshot omitted]');
  });

  // -- Edge cases --

  it('handles empty data gracefully', async () => {
    const data = makeData({
      timeline: makeTimeline(),
      correlationGroups: [],
    });
    const output = await reporter.generate(data);
    const parsed = JSON.parse(output);
    expect(parsed.timeline.entries).toHaveLength(0);
    expect(parsed.correlationGroups).toHaveLength(0);
  });

  it('preserves non-browser/non-network events unmodified', async () => {
    const logEvent: LogEvent = {
      id: uid(),
      sessionId: 'sess-json',
      timestamp: 1700000001000,
      source: 'log',
      level: 'info',
      message: 'hello',
      rawLine: 'hello',
      logSource: { type: 'stdout', name: 'app' },
    } as LogEvent;
    const data = makeData({ timeline: makeTimeline([makeEntry(logEvent)]) });
    const output = await reporter.generate(data, { includeRequestBodies: false });
    const parsed = JSON.parse(output);
    expect(parsed.timeline.entries[0].event.message).toBe('hello');
    expect(parsed.timeline.entries[0].event.level).toBe('info');
  });
});
