import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarkdownReporter } from '../../src/adapters/markdown.adapter.js';
import type { ReportData, ReportOptions } from '@probe/core';
import type {
  ProbeEvent,
  RequestEvent,
  ResponseEvent,
  LogEvent,
  BrowserErrorEvent,
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
    id: 'sess-abc123',
    name: 'Test Session',
    status: 'completed' as const,
    startedAt: 1700000000000,
    endedAt: 1700000060000,
    eventCount: 42,
    config: {},
    tags: [],
    ...overrides,
  };
}

function makeTimeline(entries: TimelineEntry[] = [], statsOverrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-abc123',
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
    sessionId: 'sess-abc123',
    timestamp: 1700000001000,
    source: 'log',
    level: 'info',
    message: 'test log message',
    rawLine: 'test log message',
    logSource: { type: 'stdout', name: 'app' },
    ...overrides,
  } as LogEvent;
}

function makeRequestEvent(overrides: Partial<RequestEvent> = {}): RequestEvent {
  return {
    id: uid(),
    sessionId: 'sess-abc123',
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
    sessionId: 'sess-abc123',
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
    sessionId: 'sess-abc123',
    timestamp: 1700000003000,
    source: 'browser',
    type: 'error',
    pageUrl: 'https://app.example.com',
    errorType: 'uncaught',
    message: 'Cannot read property x of null',
    stack: 'Error: Cannot read property x of null\n  at main.js:10:5',
    ...overrides,
  } as BrowserErrorEvent;
}

function makeSummary(overrides: Partial<CorrelationSummary> = {}): CorrelationSummary {
  return {
    trigger: 'click on button',
    hasScreenshot: false,
    hasError: false,
    errorMessages: [],
    logCount: 2,
    dbQueryCount: 1,
    dbTotalDuration: 50,
    entitiesInvolved: [],
    ...overrides,
  };
}

function makeCorrelationGroup(overrides: Partial<CorrelationGroup> = {}): CorrelationGroup {
  return {
    id: 'group-abcdef1234567890',
    sessionId: 'sess-abc123',
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

describe('MarkdownReporter', () => {
  let reporter: MarkdownReporter;

  beforeEach(() => {
    reporter = new MarkdownReporter();
    idCounter = 0;
  });

  // -- Format metadata --

  it('returns markdown format', () => {
    expect(reporter.getFormat()).toBe('markdown');
  });

  it('returns text/markdown mime type', () => {
    expect(reporter.getMimeType()).toBe('text/markdown');
  });

  it('returns md file extension', () => {
    expect(reporter.getFileExtension()).toBe('md');
  });

  // -- Header --

  it('renders header with session metadata', async () => {
    const md = await reporter.generate(makeData());
    expect(md).toContain('# Debug Report — Test Session');
    expect(md).toContain('sess-abc123');
    expect(md).toContain('completed');
    expect(md).toContain('Events');
    expect(md).toContain('42');
  });

  it('uses custom title from options', async () => {
    const md = await reporter.generate(makeData(), { title: 'Custom Title' });
    expect(md).toContain('# Custom Title');
    expect(md).not.toContain('Debug Report —');
  });

  it('renders duration when session has endedAt', async () => {
    const md = await reporter.generate(makeData());
    expect(md).toContain('Duration');
    expect(md).toContain('Ended');
  });

  it('omits duration/ended when session has no endedAt', async () => {
    const data = makeData({ session: makeSession({ endedAt: undefined }) });
    const md = await reporter.generate(data);
    expect(md).not.toContain('Ended');
    expect(md).not.toContain('Duration');
  });

  it('renders tags in header when present', async () => {
    const data = makeData({ session: makeSession({ tags: ['api', 'debug'] }) });
    const md = await reporter.generate(data);
    expect(md).toContain('api, debug');
    expect(md).toContain('Tags');
  });

  it('omits tags row when no tags', async () => {
    const data = makeData({ session: makeSession({ tags: [] }) });
    const md = await reporter.generate(data);
    expect(md).not.toContain('Tags');
  });

  // -- Summary --

  it('renders summary with stats', async () => {
    const data = makeData({
      timeline: makeTimeline([], {
        totalEvents: 100,
        correlationGroups: 5,
        errors: 3,
        avgResponseTime: 250,
      }),
    });
    const md = await reporter.generate(data);
    expect(md).toContain('## Summary');
    expect(md).toContain('100');
    expect(md).toContain('5');
    expect(md).toContain('3');
    expect(md).toContain('Avg Response Time');
  });

  it('omits avg response time when undefined', async () => {
    const data = makeData({
      timeline: makeTimeline([], { avgResponseTime: undefined }),
    });
    const md = await reporter.generate(data);
    expect(md).not.toContain('Avg Response Time');
  });

  it('renders events by source in summary', async () => {
    const data = makeData({
      timeline: makeTimeline([], {
        bySource: { browser: 10, network: 5, log: 20, sdk: 3, correlation: 0 },
      }),
    });
    const md = await reporter.generate(data);
    expect(md).toContain('`browser`: 10');
    expect(md).toContain('`network`: 5');
    expect(md).toContain('`log`: 20');
    expect(md).toContain('`sdk`: 3');
    expect(md).not.toContain('`correlation`: 0');
  });

  // -- Timeline --

  it('renders timeline entries with numbered list', async () => {
    const event: ProbeEvent = {
      id: uid(), sessionId: 'sess-abc123', timestamp: 1700000001000, source: 'sdk', type: 'custom',
    };
    const data = makeData({
      timeline: makeTimeline([makeEntry(event, 0, 'group-123')]),
    });
    const md = await reporter.generate(data);
    expect(md).toContain('## Timeline');
    expect(md).toMatch(/1\./);
    expect(md).toContain('[group:group-12');
  });

  it('respects maxEventsPerGroup option for timeline cap', async () => {
    const entries: TimelineEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(makeEntry({
        id: uid(), sessionId: 'sess-abc123', timestamp: 1700000000000 + i * 1000, source: 'sdk', type: 'custom',
      }));
    }
    const data = makeData({ timeline: makeTimeline(entries) });
    const md = await reporter.generate(data, { maxEventsPerGroup: 3 });
    expect(md).toContain('…and 7 more events');
  });

  it('returns empty string for timeline when no entries', async () => {
    const data = makeData({ timeline: makeTimeline([]) });
    const md = await reporter.generate(data);
    expect(md).not.toContain('## Timeline');
  });

  it('renders indentation based on entry depth', async () => {
    const event: ProbeEvent = {
      id: uid(), sessionId: 'sess-abc123', timestamp: 1700000001000, source: 'sdk', type: 'custom',
    };
    const data = makeData({
      timeline: makeTimeline([makeEntry(event, 3)]),
    });
    const md = await reporter.generate(data);
    // depth 3 = 6 spaces of indent
    expect(md).toContain('      ');
  });

  // -- Network Requests --

  it('renders network requests table', async () => {
    const req = makeRequestEvent();
    const res = makeResponseEvent();
    const data = makeData({
      timeline: makeTimeline([makeEntry(req), makeEntry(res)]),
    });
    const md = await reporter.generate(data);
    expect(md).toContain('## Network Requests');
    expect(md).toContain('| GET |');
    expect(md).toContain('200');
    expect(md).toContain('api.example.com');
  });

  it('truncates URLs longer than 80 chars in network table', async () => {
    const longUrl = 'https://api.example.com/' + 'a'.repeat(100);
    const req = makeRequestEvent({ url: longUrl });
    const data = makeData({ timeline: makeTimeline([makeEntry(req)]) });
    const md = await reporter.generate(data);
    expect(md).toContain('...');
    // The network table should have the truncated URL (77 chars + ...)
    const networkSection = md.split('## Network Requests')[1]!;
    const tableLines = networkSection.split('\n').filter(l => l.startsWith('|'));
    const urlLine = tableLines.find(l => l.includes('GET'));
    expect(urlLine).toContain('...');
    expect(urlLine).not.toContain(longUrl);
  });

  it('shows pending status for requests without response', async () => {
    const req = makeRequestEvent({ requestId: 'orphan-req' });
    const data = makeData({ timeline: makeTimeline([makeEntry(req)]) });
    const md = await reporter.generate(data);
    expect(md).toContain('pending');
  });

  it('renders request/response bodies when option enabled', async () => {
    const req = makeRequestEvent({ body: '{"key":"value"}' });
    const res = makeResponseEvent({ body: '{"result":"ok"}' });
    const data = makeData({ timeline: makeTimeline([makeEntry(req), makeEntry(res)]) });
    const md = await reporter.generate(data, { includeRequestBodies: true });
    expect(md).toContain('Request Body');
    expect(md).toContain('Response Body');
    expect(md).toContain('{"key":"value"}');
    expect(md).toContain('{"result":"ok"}');
  });

  it('does not render network section when no requests', async () => {
    const md = await reporter.generate(makeData());
    expect(md).not.toContain('## Network Requests');
  });

  // -- escPipe --

  it('escapes pipe characters in table cells', async () => {
    const data = makeData({
      session: makeSession({ name: 'test|pipe|session' }),
    });
    const md = await reporter.generate(data);
    // Table cells use escPipe which escapes pipes
    expect(md).toContain('test\\|pipe\\|session');
    // The table row should contain the escaped version
    const tableLines = md.split('\n').filter(l => l.startsWith('|'));
    const sessionLine = tableLines.find(l => l.includes('Session'));
    expect(sessionLine).toContain('test\\|pipe\\|session');
  });

  it('escapes newlines in table cells', async () => {
    const data = makeData({
      session: makeSession({ name: 'line1\nline2' }),
    });
    const md = await reporter.generate(data);
    // Table cells use escPipe which replaces newlines with spaces
    const tableLines = md.split('\n').filter(l => l.startsWith('|'));
    const sessionLine = tableLines.find(l => l.includes('Session'));
    expect(sessionLine).toContain('line1 line2');
    expect(sessionLine).not.toContain('line1\n');
  });

  // -- Code fence escaping --

  it('escapes code fences in stack traces', async () => {
    const error = makeBrowserErrorEvent({
      stack: 'Error\n```\nsome nested fence\n```',
    });
    const data = makeData({
      timeline: makeTimeline([makeEntry(error)]),
    });
    const md = await reporter.generate(data);
    expect(md).toContain('\\`\\`\\`');
  });

  it('escapes code fences in request bodies', async () => {
    const req = makeRequestEvent({ body: 'data with ``` backticks' });
    const res = makeResponseEvent();
    const data = makeData({ timeline: makeTimeline([makeEntry(req), makeEntry(res)]) });
    const md = await reporter.generate(data, { includeRequestBodies: true });
    expect(md).toContain('\\`\\`\\`');
  });

  // -- Errors --

  it('renders browser errors with stack trace', async () => {
    const error = makeBrowserErrorEvent();
    const data = makeData({
      timeline: makeTimeline([makeEntry(error)]),
    });
    const md = await reporter.generate(data);
    expect(md).toContain('## Errors (1)');
    expect(md).toContain('**uncaught**');
    expect(md).toContain('Cannot read property x of null');
    expect(md).toContain('main.js:10:5');
  });

  it('renders log errors', async () => {
    const log = makeLogEvent({ level: 'error', message: 'Database connection failed' });
    const data = makeData({
      timeline: makeTimeline([makeEntry(log)]),
    });
    const md = await reporter.generate(data);
    expect(md).toContain('## Errors');
    expect(md).toContain('**[ERROR]**');
    expect(md).toContain('Database connection failed');
  });

  it('renders HTTP 4xx/5xx responses as errors', async () => {
    const res = makeResponseEvent({ statusCode: 500, statusText: 'Internal Server Error' });
    const data = makeData({
      timeline: makeTimeline([makeEntry(res)]),
    });
    const md = await reporter.generate(data);
    expect(md).toContain('**HTTP 500**');
    expect(md).toContain('Internal Server Error');
  });

  it('does not render errors section when no errors', async () => {
    const md = await reporter.generate(makeData());
    expect(md).not.toContain('## Errors');
  });

  // -- Correlation Groups --

  it('renders correlation groups', async () => {
    const group = makeCorrelationGroup({
      summary: makeSummary({
        trigger: 'click on #submit',
        httpMethod: 'POST',
        httpUrl: '/api/form',
        httpStatus: 201,
        totalDuration: 340,
        hasError: false,
        logCount: 5,
        dbQueryCount: 2,
        entitiesInvolved: ['User', 'Order'],
      }),
      events: [makeLogEvent()],
    });
    const data = makeData({ correlationGroups: [group] });
    const md = await reporter.generate(data);
    expect(md).toContain('## Correlation Groups (1)');
    expect(md).toContain('click on #submit');
    expect(md).toContain('POST');
    expect(md).toContain('/api/form');
    expect(md).toContain('201');
    expect(md).toContain('User, Order');
    expect(md).toContain('Events**: 1');
    expect(md).toContain('Logs: 5');
    expect(md).toContain('DB Queries: 2');
  });

  it('renders error messages in correlation groups', async () => {
    const group = makeCorrelationGroup({
      summary: makeSummary({
        hasError: true,
        errorMessages: ['timeout', 'connection refused'],
      }),
    });
    const data = makeData({ correlationGroups: [group] });
    const md = await reporter.generate(data);
    expect(md).toContain('timeout; connection refused');
  });

  it('does not render groups section when empty', async () => {
    const md = await reporter.generate(makeData());
    expect(md).not.toContain('## Correlation Groups');
  });

  // -- Logs --

  it('renders logs with level badges', async () => {
    const logs = [
      makeLogEvent({ level: 'info', message: 'info msg', timestamp: 1700000001000 }),
      makeLogEvent({ level: 'warn', message: 'warn msg', timestamp: 1700000002000 }),
      makeLogEvent({ level: 'error', message: 'error msg', timestamp: 1700000003000 }),
      makeLogEvent({ level: 'debug', message: 'debug msg', timestamp: 1700000004000 }),
      makeLogEvent({ level: 'fatal', message: 'fatal msg', timestamp: 1700000005000 }),
      makeLogEvent({ level: 'trace', message: 'trace msg', timestamp: 1700000006000 }),
    ];
    const data = makeData({
      timeline: makeTimeline(logs.map((l) => makeEntry(l))),
    });
    const md = await reporter.generate(data);
    expect(md).toContain('## Logs (6)');
    expect(md).toContain('ℹ️');
    expect(md).toContain('⚠️');
    expect(md).toContain('❌');
    expect(md).toContain('🐛');
    expect(md).toContain('💀');
    expect(md).toContain('🔍');
    expect(md).toContain('**[INFO]** info msg');
    expect(md).toContain('**[WARN]** warn msg');
  });

  it('omits logs section when includeLogLines is false', async () => {
    const log = makeLogEvent();
    const data = makeData({ timeline: makeTimeline([makeEntry(log)]) });
    const md = await reporter.generate(data, { includeLogLines: false });
    expect(md).not.toContain('## Logs');
  });

  it('omits logs section when no log events', async () => {
    const md = await reporter.generate(makeData());
    expect(md).not.toContain('## Logs');
  });

  // -- Footer --

  it('renders footer with generation timestamp', async () => {
    const md = await reporter.generate(makeData());
    expect(md).toContain('---');
    expect(md).toContain('Generated by Debug Probe');
  });

  // -- Edge cases --

  it('handles null/undefined values in escPipe gracefully', async () => {
    const data = makeData({
      session: makeSession({ name: undefined as unknown as string }),
    });
    const md = await reporter.generate(data);
    // Should not throw, should contain escaped empty or 'undefined'
    expect(md).toBeDefined();
  });

  it('generates valid markdown for completely empty data', async () => {
    const data = makeData({
      timeline: makeTimeline([], { totalEvents: 0, bySource: { browser: 0, network: 0, log: 0, sdk: 0, correlation: 0 } }),
      correlationGroups: [],
    });
    const md = await reporter.generate(data);
    expect(md).toContain('# Debug Report');
    expect(md).toContain('## Summary');
    expect(md).toContain('---');
  });
});
