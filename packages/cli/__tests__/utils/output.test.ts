// ============================================================
// CLI Output Utils — Tests for formatEvent, formatSummary,
// describeEvent, printBanner (no-chalk fallback path)
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatEvent, formatSummary, printBanner } from '../../src/utils/output.js';

// These tests run WITHOUT calling initOutput() so they exercise
// the no-chalk fallback code path (synchronous chalk not loaded).

describe('formatEvent (no chalk)', () => {
  it('formats browser click events', () => {
    const event: any = {
      source: 'browser',
      type: 'click',
      timestamp: 1000,
      id: 'e1',
      sessionId: 's1',
      selector: '#btn',
    };
    const result = formatEvent(event);
    expect(result).toContain('[browser]');
    expect(result).toContain('Click: #btn');
  });

  it('formats browser navigation events', () => {
    const event: any = {
      source: 'browser',
      type: 'navigation',
      timestamp: 1000,
      id: 'e2',
      sessionId: 's1',
      toUrl: 'https://example.com',
    };
    const result = formatEvent(event);
    expect(result).toContain('Navigate: https://example.com');
  });

  it('formats browser screenshot events', () => {
    const event: any = {
      source: 'browser',
      type: 'screenshot',
      timestamp: 1000,
      id: 'e3',
      sessionId: 's1',
      trigger: 'periodic',
    };
    const result = formatEvent(event);
    expect(result).toContain('Screenshot (periodic)');
  });

  it('formats browser console events', () => {
    const event: any = {
      source: 'browser',
      type: 'console',
      timestamp: 1000,
      id: 'e4',
      sessionId: 's1',
      level: 'warn',
      message: 'Deprecated API',
    };
    const result = formatEvent(event);
    expect(result).toContain('Console.warn: Deprecated API');
  });

  it('formats browser error events', () => {
    const event: any = {
      source: 'browser',
      type: 'error',
      timestamp: 1000,
      id: 'e5',
      sessionId: 's1',
      message: 'TypeError',
    };
    const result = formatEvent(event);
    expect(result).toContain('Error: TypeError');
  });

  it('formats unknown browser events', () => {
    const event: any = {
      source: 'browser',
      type: 'custom-thing',
      timestamp: 1000,
      id: 'e6',
      sessionId: 's1',
    };
    const result = formatEvent(event);
    expect(result).toContain('Browser: custom-thing');
  });

  it('formats network request events', () => {
    const event: any = {
      source: 'network',
      type: 'request',
      timestamp: 1000,
      id: 'e7',
      sessionId: 's1',
      method: 'GET',
      url: 'https://api.com/data',
    };
    const result = formatEvent(event);
    expect(result).toContain('→ GET https://api.com/data');
  });

  it('formats network response events', () => {
    const event: any = {
      source: 'network',
      type: 'response',
      timestamp: 1000,
      id: 'e8',
      sessionId: 's1',
      statusCode: 200,
      duration: 42,
    };
    const result = formatEvent(event);
    expect(result).toContain('← 200 (42ms)');
  });

  it('formats sdk events', () => {
    const event: any = {
      source: 'sdk',
      type: 'request-start',
      timestamp: 1000,
      id: 'e9',
      sessionId: 's1',
    };
    const result = formatEvent(event);
    expect(result).toContain('[sdk]');
    expect(result).toContain('SDK: request-start');
  });

  it('formats correlation events', () => {
    const event: any = {
      source: 'correlation',
      type: 'group',
      timestamp: 1000,
      id: 'e10',
      sessionId: 's1',
    };
    const result = formatEvent(event);
    expect(result).toContain('Correlation: group updated');
  });

  it('formats unknown source events', () => {
    const event: any = {
      source: 'custom' as any,
      type: 'something',
      timestamp: 1000,
      id: 'e11',
      sessionId: 's1',
    };
    const result = formatEvent(event);
    expect(result).toContain('custom: event');
  });
});

describe('formatSummary (no chalk)', () => {
  const session: any = {
    id: 's1',
    name: 'Test Session',
    status: 'completed',
    config: {},
    startedAt: 1000,
    endedAt: 2000,
    eventCount: 10,
  };

  const timeline: any = {
    duration: 60000,
    stats: {
      totalEvents: 42,
      correlationGroups: 3,
      errors: 1,
      bySource: { browser: 20, network: 15, log: 7 },
    },
  };

  it('includes session name', () => {
    const result = formatSummary(session, timeline);
    expect(result).toContain('Test Session');
  });

  it('includes total events', () => {
    const result = formatSummary(session, timeline);
    expect(result).toContain('42');
  });

  it('includes correlation groups count', () => {
    const result = formatSummary(session, timeline);
    expect(result).toContain('3');
  });

  it('includes error count', () => {
    const result = formatSummary(session, timeline);
    expect(result).toContain('1');
  });
});

describe('printBanner (no chalk)', () => {
  it('prints version info to console', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printBanner();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Debug Probe'));
    spy.mockRestore();
  });
});
