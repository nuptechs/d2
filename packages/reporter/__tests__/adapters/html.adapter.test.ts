import { describe, it, expect, beforeEach } from 'vitest';
import { HtmlReporter } from '../../src/adapters/html.adapter.js';
import type { ReportData, ReportOptions } from '@probe/core';
import type {
  ProbeEvent,
  RequestEvent,
  ResponseEvent,
  LogEvent,
  BrowserErrorEvent,
  ScreenshotEvent,
  CorrelationGroup,
  CorrelationSummary,
  TimelineEntry,
} from '@probe/core';

// ---- Helpers ----

let idCounter = 0;
function uid(): string {
  return `test-id-${++idCounter}`;
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-html-test',
    name: 'HTML Test Session',
    status: 'completed' as const,
    startedAt: 1700000000000,
    endedAt: 1700000060000,
    eventCount: 10,
    config: {},
    tags: [],
    ...overrides,
  };
}

function makeTimeline(entries: TimelineEntry[] = [], statsOverrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-html-test',
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

function makeLogEvent(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    id: uid(),
    sessionId: 'sess-html-test',
    timestamp: 1700000001000,
    source: 'log',
    level: 'info',
    message: 'test log',
    rawLine: 'test log',
    logSource: { type: 'stdout', name: 'app' },
    ...overrides,
  } as LogEvent;
}

function makeRequestEvent(overrides: Partial<RequestEvent> = {}): RequestEvent {
  return {
    id: uid(),
    sessionId: 'sess-html-test',
    timestamp: 1700000001000,
    source: 'network',
    type: 'request',
    requestId: 'req-1',
    method: 'GET',
    url: 'https://api.example.com/data',
    headers: {},
    ...overrides,
  } as RequestEvent;
}

function makeResponseEvent(overrides: Partial<ResponseEvent> = {}): ResponseEvent {
  return {
    id: uid(),
    sessionId: 'sess-html-test',
    timestamp: 1700000002000,
    source: 'network',
    type: 'response',
    requestId: 'req-1',
    statusCode: 200,
    statusText: 'OK',
    headers: {},
    duration: 150,
    ...overrides,
  } as ResponseEvent;
}

function makeBrowserErrorEvent(overrides: Record<string, unknown> = {}): BrowserErrorEvent {
  return {
    id: uid(),
    sessionId: 'sess-html-test',
    timestamp: 1700000003000,
    source: 'browser',
    type: 'error',
    pageUrl: 'https://app.example.com',
    errorType: 'uncaught',
    message: 'Unexpected token',
    stack: 'Error: Unexpected token\n  at eval.js:1:1',
    ...overrides,
  } as BrowserErrorEvent;
}

function makeScreenshotEvent(overrides: Partial<ScreenshotEvent> = {}): ScreenshotEvent {
  return {
    id: uid(),
    sessionId: 'sess-html-test',
    timestamp: 1700000002000,
    source: 'browser',
    type: 'screenshot',
    pageUrl: 'https://app.example.com',
    data: 'iVBORw0KGgoAAAANSUhEUg==',
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
    logCount: 1,
    dbQueryCount: 0,
    dbTotalDuration: 0,
    entitiesInvolved: [],
    ...overrides,
  };
}

function makeCorrelationGroup(overrides: Partial<CorrelationGroup> = {}): CorrelationGroup {
  return {
    id: 'group-html-abcdef12',
    sessionId: 'sess-html-test',
    correlationId: 'corr-1',
    createdAt: 1700000000000,
    events: [],
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

describe('HtmlReporter', () => {
  let reporter: HtmlReporter;

  beforeEach(() => {
    reporter = new HtmlReporter();
    idCounter = 0;
  });

  // -- Format metadata --

  it('returns html format', () => {
    expect(reporter.getFormat()).toBe('html');
  });

  it('returns text/html mime type', () => {
    expect(reporter.getMimeType()).toBe('text/html');
  });

  it('returns html file extension', () => {
    expect(reporter.getFileExtension()).toBe('html');
  });

  // -- Full report structure --

  it('generates valid HTML document structure', async () => {
    const html = await reporter.generate(makeData());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<head>');
    expect(html).toContain('</head>');
    expect(html).toContain('<body>');
    expect(html).toContain('</body>');
    expect(html).toContain('</html>');
  });

  it('includes CSS styles', async () => {
    const html = await reporter.generate(makeData());
    expect(html).toContain('<style>');
    expect(html).toContain('</style>');
    expect(html).toContain('--bg:');
    expect(html).toContain('--accent:');
  });

  it('includes script for collapsible groups', async () => {
    const html = await reporter.generate(makeData());
    expect(html).toContain('<script>');
    expect(html).toContain('group-header');
    expect(html).toContain('toggle');
  });

  // -- HTML escaping --

  it('escapes HTML special characters in session name', async () => {
    const data = makeData({
      session: makeSession({ name: '<script>alert("xss")</script>' }),
    });
    const html = await reporter.generate(data);
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;xss&quot;');
  });

  it('escapes HTML in custom title', async () => {
    const html = await reporter.generate(makeData(), { title: 'Report <b>bold</b>' });
    expect(html).toContain('Report &lt;b&gt;bold&lt;/b&gt;');
    expect(html).not.toContain('<b>bold</b>');
  });

  it('escapes HTML in error messages', async () => {
    const error = makeBrowserErrorEvent({
      message: '<img src=x onerror=alert(1)>',
      errorType: 'uncaught',
    });
    const data = makeData({ timeline: makeTimeline([makeEntry(error)]) });
    const html = await reporter.generate(data);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('escapes HTML in log messages', async () => {
    const log = makeLogEvent({ level: 'error', message: 'Error: <div onclick="bad()">click</div>' });
    const data = makeData({ timeline: makeTimeline([makeEntry(log)]) });
    const html = await reporter.generate(data);
    expect(html).toContain('&lt;div onclick=');
  });

  it('escapes ampersands correctly', async () => {
    const data = makeData({
      session: makeSession({ name: 'Test & Debug' }),
    });
    const html = await reporter.generate(data);
    expect(html).toContain('Test &amp; Debug');
  });

  it('escapes single quotes', async () => {
    const data = makeData({
      session: makeSession({ name: "Test's Session" }),
    });
    const html = await reporter.generate(data);
    expect(html).toContain('Test&#39;s Session');
  });

  // -- Header section --

  it('renders header with session ID and status', async () => {
    const html = await reporter.generate(makeData());
    expect(html).toContain('class="header"');
    expect(html).toContain('sess-html-te'); // sliced to 12 chars
    expect(html).toContain('completed');
  });

  it('shows ongoing when no endedAt', async () => {
    const data = makeData({ session: makeSession({ endedAt: undefined }) });
    const html = await reporter.generate(data);
    expect(html).toContain('ongoing');
  });

  // -- Summary cards --

  it('renders summary cards with stats', async () => {
    const data = makeData({
      timeline: makeTimeline([], {
        totalEvents: 100,
        correlationGroups: 5,
        errors: 3,
        avgResponseTime: 250,
      }),
    });
    const html = await reporter.generate(data);
    expect(html).toContain('class="cards"');
    expect(html).toContain('Total Events');
    expect(html).toContain('100');
    expect(html).toContain('Correlation Groups');
    expect(html).toContain('5');
    expect(html).toContain('Errors');
    expect(html).toContain('error'); // error class on card
  });

  it('shows dash for avg response time when undefined', async () => {
    const data = makeData({
      timeline: makeTimeline([], { avgResponseTime: undefined }),
    });
    const html = await reporter.generate(data);
    expect(html).toContain('—');
  });

  it('applies success class when zero errors', async () => {
    const data = makeData({
      timeline: makeTimeline([], { errors: 0 }),
    });
    const html = await reporter.generate(data);
    expect(html).toContain('success');
  });

  // -- Timeline --

  it('renders timeline entries', async () => {
    const event: ProbeEvent = {
      id: uid(), sessionId: 'sess-html-test', timestamp: 1700000001000, source: 'sdk', type: 'custom',
    };
    const data = makeData({ timeline: makeTimeline([makeEntry(event)]) });
    const html = await reporter.generate(data);
    expect(html).toContain('Timeline (1 events)');
    expect(html).toContain('class="timeline"');
    expect(html).toContain('data-source="sdk"');
  });

  it('caps timeline entries with maxEventsPerGroup', async () => {
    const entries: TimelineEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(makeEntry({
        id: uid(), sessionId: 'sess-html-test', timestamp: 1700000000000 + i * 1000, source: 'sdk', type: 'custom',
      }));
    }
    const data = makeData({ timeline: makeTimeline(entries) });
    const html = await reporter.generate(data, { maxEventsPerGroup: 3 });
    expect(html).toContain('and 7 more events');
  });

  it('skips timeline section when no entries', async () => {
    const html = await reporter.generate(makeData());
    expect(html).not.toContain('Timeline (0 events)');
  });

  it('applies margin-left based on depth', async () => {
    const event: ProbeEvent = {
      id: uid(), sessionId: 'sess-html-test', timestamp: 1700000001000, source: 'sdk', type: 'custom',
    };
    const data = makeData({ timeline: makeTimeline([makeEntry(event, 2)]) });
    const html = await reporter.generate(data);
    expect(html).toContain('margin-left:48px');
  });

  // -- Correlation groups --

  it('renders collapsible correlation groups', async () => {
    const group = makeCorrelationGroup({
      summary: makeSummary({
        trigger: 'click on #btn',
        httpMethod: 'POST',
        httpUrl: '/api/submit',
        httpStatus: 200,
        totalDuration: 500,
      }),
      events: [makeLogEvent()],
    });
    const data = makeData({ correlationGroups: [group] });
    const html = await reporter.generate(data);
    expect(html).toContain('Correlation Groups (1)');
    expect(html).toContain('group-card');
    expect(html).toContain('group-header');
    expect(html).toContain('group-body');
    expect(html).toContain('click on #btn');
    expect(html).toContain('POST');
  });

  it('applies error badge class when group has errors', async () => {
    const group = makeCorrelationGroup({
      summary: makeSummary({ hasError: true }),
    });
    const data = makeData({ correlationGroups: [group] });
    const html = await reporter.generate(data);
    expect(html).toContain('badge error');
  });

  it('escapes httpStatus in correlation groups', async () => {
    const group = makeCorrelationGroup({
      summary: makeSummary({
        httpMethod: 'GET',
        httpUrl: '/api',
        httpStatus: 500,
      }),
    });
    const data = makeData({ correlationGroups: [group] });
    const html = await reporter.generate(data);
    expect(html).toContain('500');
  });

  // -- Screenshots --

  it('renders screenshot gallery', async () => {
    const ss = makeScreenshotEvent();
    const data = makeData({ timeline: makeTimeline([makeEntry(ss)]) });
    const html = await reporter.generate(data);
    expect(html).toContain('Screenshots (1)');
    expect(html).toContain('class="screenshots"');
    expect(html).toContain('data:image/png;base64,');
    expect(html).toContain('Test Screenshot');
  });

  it('omits screenshots when includeScreenshots is false', async () => {
    const ss = makeScreenshotEvent();
    const data = makeData({ timeline: makeTimeline([makeEntry(ss)]) });
    const html = await reporter.generate(data, { includeScreenshots: false });
    expect(html).not.toContain('Screenshots');
  });

  it('sanitizes base64 data in screenshots', async () => {
    const ss = makeScreenshotEvent({
      data: 'abc123+/=\n<script>bad</script>',
    });
    const data = makeData({ timeline: makeTimeline([makeEntry(ss)]) });
    const html = await reporter.generate(data);
    expect(html).not.toContain('<script>bad</script>');
    expect(html).toContain('abc123+/=');
  });

  // -- Errors section --

  it('renders browser errors', async () => {
    const error = makeBrowserErrorEvent();
    const data = makeData({ timeline: makeTimeline([makeEntry(error)]) });
    const html = await reporter.generate(data);
    expect(html).toContain('Errors (1)');
    expect(html).toContain('error-entry');
    expect(html).toContain('uncaught');
    expect(html).toContain('Unexpected token');
  });

  it('renders log fatal/error as errors', async () => {
    const log = makeLogEvent({ level: 'fatal', message: 'OOM crash' });
    const data = makeData({ timeline: makeTimeline([makeEntry(log)]) });
    const html = await reporter.generate(data);
    expect(html).toContain('FATAL');
    expect(html).toContain('OOM crash');
  });

  it('renders HTTP 4xx/5xx responses as errors', async () => {
    const res = makeResponseEvent({ statusCode: 404, statusText: 'Not Found' });
    const data = makeData({ timeline: makeTimeline([makeEntry(res)]) });
    const html = await reporter.generate(data);
    expect(html).toContain('HTTP 404');
    expect(html).toContain('Not Found');
  });

  it('escapes stack traces in error pre blocks', async () => {
    const error = makeBrowserErrorEvent({
      stack: 'Error at <anonymous>:1:1',
    });
    const data = makeData({ timeline: makeTimeline([makeEntry(error)]) });
    const html = await reporter.generate(data);
    expect(html).toContain('&lt;anonymous&gt;');
  });

  // -- Network section --

  it('renders network table with status classes', async () => {
    const req = makeRequestEvent();
    const res = makeResponseEvent({ statusCode: 201 });
    const data = makeData({ timeline: makeTimeline([makeEntry(req), makeEntry(res)]) });
    const html = await reporter.generate(data);
    expect(html).toContain('Network Trace');
    expect(html).toContain('s2xx');
    expect(html).toContain('201');
  });

  it('applies s5xx class for 500 status codes', async () => {
    const req = makeRequestEvent();
    const res = makeResponseEvent({ statusCode: 503 });
    const data = makeData({ timeline: makeTimeline([makeEntry(req), makeEntry(res)]) });
    const html = await reporter.generate(data);
    expect(html).toContain('s5xx');
  });

  it('applies s4xx class for 400 status codes', async () => {
    const req = makeRequestEvent();
    const res = makeResponseEvent({ statusCode: 422 });
    const data = makeData({ timeline: makeTimeline([makeEntry(req), makeEntry(res)]) });
    const html = await reporter.generate(data);
    expect(html).toContain('s4xx');
  });

  it('shows pending for requests without response', async () => {
    const req = makeRequestEvent({ requestId: 'no-response' });
    const data = makeData({ timeline: makeTimeline([makeEntry(req)]) });
    const html = await reporter.generate(data);
    expect(html).toContain('pending');
  });

  it('renders request/response bodies when option set', async () => {
    const req = makeRequestEvent({ body: '{"name":"test"}' });
    const res = makeResponseEvent({ body: '{"ok":true}' });
    const data = makeData({ timeline: makeTimeline([makeEntry(req), makeEntry(res)]) });
    const html = await reporter.generate(data, { includeRequestBodies: true });
    expect(html).toContain('Request');
    expect(html).toContain('Response');
  });

  // -- Logs section --

  it('renders log entries with level classes', async () => {
    const logs = [
      makeLogEvent({ level: 'info', message: 'started' }),
      makeLogEvent({ level: 'warn', message: 'slow query' }),
      makeLogEvent({ level: 'error', message: 'failed' }),
    ];
    const data = makeData({ timeline: makeTimeline(logs.map((l) => makeEntry(l))) });
    const html = await reporter.generate(data);
    expect(html).toContain('Logs (3)');
    expect(html).toContain('class="lvl info"');
    expect(html).toContain('class="lvl warn"');
    expect(html).toContain('class="lvl error"');
    expect(html).toContain('INFO');
    expect(html).toContain('WARN');
    expect(html).toContain('ERROR');
  });

  it('omits logs when includeLogLines is false', async () => {
    const log = makeLogEvent();
    const data = makeData({ timeline: makeTimeline([makeEntry(log)]) });
    const html = await reporter.generate(data, { includeLogLines: false });
    expect(html).not.toContain('Logs (');
  });

  // -- Footer --

  it('renders footer with generation timestamp', async () => {
    const html = await reporter.generate(makeData());
    expect(html).toContain('class="footer"');
    expect(html).toContain('Generated by Debug Probe');
  });

  // -- Print styles --

  it('includes print media query', async () => {
    const html = await reporter.generate(makeData());
    expect(html).toContain('@media print');
  });
});
