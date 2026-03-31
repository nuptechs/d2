// ============================================================
// UrlMatchingStrategy — Correlates events sharing the same URL
// ============================================================

import type {
  ProbeEvent,
  CorrelationGroup,
  CorrelationStrategyType,
  BrowserEvent,
  NavigationEvent,
  RequestEvent,
  LogEvent,
} from '@probe/core';
import {
  isBrowserEvent,
  isNetworkEvent,
  isRequestEvent,
  isLogEvent,
} from '@probe/core';
import { CorrelationStrategy } from './base.strategy.js';

export class UrlMatchingStrategy extends CorrelationStrategy {
  getName(): CorrelationStrategyType {
    return 'url-matching';
  }

  tryCorrelate(
    event: ProbeEvent,
    existingGroups: Map<string, CorrelationGroup>,
  ): string | null {
    const eventUrl = this.extractUrl(event);
    if (!eventUrl) return null;

    const normalizedEventUrl = this.normalizeUrl(eventUrl);

    for (const [groupId, group] of existingGroups) {
      for (const existing of group.events) {
        const existingUrl = this.extractUrl(existing);
        if (existingUrl && this.normalizeUrl(existingUrl) === normalizedEventUrl) {
          return groupId;
        }
      }
    }

    return null;
  }

  private extractUrl(event: ProbeEvent): string | undefined {
    if (isBrowserEvent(event)) {
      const be = event as BrowserEvent;
      if (be.type === 'navigation') {
        return (event as NavigationEvent).toUrl;
      }
      return be.pageUrl;
    }

    if (isRequestEvent(event)) {
      return (event as RequestEvent).url;
    }

    if (isNetworkEvent(event)) {
      // Response events don't carry a URL directly; handled via requestId strategy
      return undefined;
    }

    if (isLogEvent(event)) {
      const log = event as LogEvent;
      return this.extractUrlFromMessage(log.message);
    }

    return undefined;
  }

  private extractUrlFromMessage(message: string): string | undefined {
    // Cap search space to first 2KB of message to avoid expensive regex scans
    const searchable = message.length > 2048 ? message.slice(0, 2048) : message;
    const urlPattern = /https?:\/\/[^\s"'<>]{1,2000}/i;
    const match = urlPattern.exec(searchable);
    return match?.[0];
  }

  /** Normalize URL by stripping query params and trailing slash for comparison */
  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      // Keep protocol + host + pathname, strip query and hash
      let path = parsed.pathname;
      if (path.length > 1 && path.endsWith('/')) {
        path = path.slice(0, -1);
      }
      return `${parsed.protocol}//${parsed.host}${path}`.toLowerCase();
    } catch {
      // If not a valid absolute URL, normalize as-is
      const qIdx = url.indexOf('?');
      const base = qIdx >= 0 ? url.slice(0, qIdx) : url;
      return base.replace(/\/+$/, '').toLowerCase();
    }
  }
}
