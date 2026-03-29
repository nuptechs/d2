// ============================================================
// SummaryBuilder — Builds CorrelationSummary from a set of events
// ============================================================

import type {
  ProbeEvent,
  CorrelationSummary,
  BrowserEvent,
  RequestEvent,
  ResponseEvent,
  LogEvent,
  SdkDbQueryEvent,
  BrowserErrorEvent,
} from '@probe/core';
import {
  isBrowserEvent,
  isRequestEvent,
  isResponseEvent,
  isLogEvent,
  isSdkEvent,
} from '@probe/core';

export function buildGroupSummary(events: readonly ProbeEvent[]): CorrelationSummary {
  let trigger: string | undefined;
  let httpMethod: string | undefined;
  let httpUrl: string | undefined;
  let httpStatus: number | undefined;
  let hasScreenshot = false;
  let hasError = false;
  const errorMessages: string[] = [];
  let logCount = 0;
  let dbQueryCount = 0;
  let dbTotalDuration = 0;
  const entitiesInvolved = new Set<string>();

  let earliestTimestamp = Infinity;
  let latestTimestamp = -Infinity;

  for (const event of events) {
    if (event.timestamp < earliestTimestamp) earliestTimestamp = event.timestamp;
    if (event.timestamp > latestTimestamp) latestTimestamp = event.timestamp;

    if (isBrowserEvent(event)) {
      const be = event as BrowserEvent;
      if (!trigger && (be.type === 'click' || be.type === 'navigation')) {
        trigger = `${be.type}:${be.pageUrl}`;
      }
      if (be.type === 'screenshot') {
        hasScreenshot = true;
      }
      if (be.type === 'error') {
        hasError = true;
        const errEvt = event as BrowserErrorEvent;
        errorMessages.push(errEvt.message);
      }
    }

    if (isRequestEvent(event)) {
      const req = event as RequestEvent;
      if (!httpMethod) {
        httpMethod = req.method;
        httpUrl = req.url;
      }
    }

    if (isResponseEvent(event)) {
      const res = event as ResponseEvent;
      if (httpStatus === undefined) {
        httpStatus = res.statusCode;
      }
      if (res.statusCode >= 400) {
        hasError = true;
        errorMessages.push(`HTTP ${res.statusCode} ${(event as ResponseEvent).statusText ?? ''}`);
      }
    }

    if (isLogEvent(event)) {
      logCount++;
      const log = event as LogEvent;
      if (log.level === 'error' || log.level === 'fatal') {
        hasError = true;
        errorMessages.push(log.message);
      }
    }

    if (isSdkEvent(event)) {
      const sdk = event as ProbeEvent & { type?: string };
      if (sdk.type === 'db-query') {
        const dbEvt = event as unknown as SdkDbQueryEvent;
        dbQueryCount++;
        dbTotalDuration += dbEvt.duration;
        const entity = extractEntityFromQuery(dbEvt.query);
        if (entity) entitiesInvolved.add(entity);
      }
      if (sdk.type === 'request-end') {
        const endEvt = event as ProbeEvent & { error?: string };
        if (endEvt.error) {
          hasError = true;
          errorMessages.push(endEvt.error);
        }
      }
    }
  }

  const totalDuration =
    earliestTimestamp !== Infinity && latestTimestamp !== -Infinity
      ? latestTimestamp - earliestTimestamp
      : undefined;

  return {
    trigger,
    httpMethod,
    httpUrl,
    httpStatus,
    totalDuration,
    hasScreenshot,
    hasError,
    errorMessages,
    logCount,
    dbQueryCount,
    dbTotalDuration,
    entitiesInvolved: [...entitiesInvolved],
  };
}

/** Simple heuristic to extract table/entity name from a SQL query */
function extractEntityFromQuery(query: string): string | undefined {
  const patterns = [
    /\bFROM\s+["']?(\w+)["']?/i,
    /\bINTO\s+["']?(\w+)["']?/i,
    /\bUPDATE\s+["']?(\w+)["']?/i,
    /\bDELETE\s+FROM\s+["']?(\w+)["']?/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(query);
    if (match?.[1]) return match[1];
  }
  return undefined;
}
