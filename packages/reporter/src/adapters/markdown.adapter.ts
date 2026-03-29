// ============================================================
// Markdown Reporter — Human-readable Markdown debug report
// ============================================================

import { ReporterPort, type ReportData, type ReportOptions } from '@probe/core';
import type {
  ProbeEvent,
  RequestEvent,
  ResponseEvent,
  LogEvent,
  BrowserErrorEvent,
} from '@probe/core';
import {
  formatDuration,
  toIso,
  isRequestEvent,
  isResponseEvent,
  isLogEvent,
  isBrowserEvent,
} from '@probe/core';

export class MarkdownReporter extends ReporterPort {
  async generate(data: ReportData, options?: ReportOptions): Promise<string> {
    const title = options?.title ?? `Debug Report — ${data.session.name}`;
    const parts: string[] = [];

    parts.push(this.renderHeader(title, data));
    parts.push(this.renderSummary(data));
    parts.push(this.renderTimeline(data, options));
    parts.push(this.renderNetworkRequests(data, options));
    parts.push(this.renderErrors(data));
    parts.push(this.renderCorrelationGroups(data, options));

    if (options?.includeLogLines !== false) {
      parts.push(this.renderLogs(data));
    }

    parts.push(this.renderFooter());

    return parts.filter(Boolean).join('\n\n');
  }

  getFormat(): string { return 'markdown'; }
  getMimeType(): string { return 'text/markdown'; }
  getFileExtension(): string { return 'md'; }

  // ---- Sections ----

  private renderHeader(title: string, data: ReportData): string {
    const s = data.session;
    const lines: string[] = [
      `# ${title}`,
      '',
      `| Field | Value |`,
      `|-------|-------|`,
      `| **Session** | ${s.name} (${s.id}) |`,
      `| **Status** | ${s.status} |`,
      `| **Started** | ${toIso(s.startedAt)} |`,
    ];
    if (s.endedAt) {
      lines.push(`| **Ended** | ${toIso(s.endedAt)} |`);
      lines.push(`| **Duration** | ${formatDuration(s.endedAt - s.startedAt)} |`);
    }
    lines.push(`| **Events** | ${s.eventCount} |`);
    if (s.tags?.length) {
      lines.push(`| **Tags** | ${s.tags.join(', ')} |`);
    }
    return lines.join('\n');
  }

  private renderSummary(data: ReportData): string {
    const stats = data.timeline.stats;
    const lines: string[] = [
      `## Summary`,
      '',
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Total Events | ${stats.totalEvents} |`,
      `| Correlation Groups | ${stats.correlationGroups} |`,
      `| Errors | ${stats.errors} |`,
    ];
    if (stats.avgResponseTime !== undefined) {
      lines.push(`| Avg Response Time | ${formatDuration(stats.avgResponseTime)} |`);
    }
    lines.push('', '**Events by Source:**', '');
    for (const [source, count] of Object.entries(stats.bySource)) {
      if (count > 0) lines.push(`- \`${source}\`: ${count}`);
    }
    return lines.join('\n');
  }

  private renderTimeline(data: ReportData, options?: ReportOptions): string {
    const entries = data.timeline.entries;
    if (entries.length === 0) return '';

    const lines: string[] = [`## Timeline`, ''];
    const maxEntries = options?.maxEventsPerGroup ?? entries.length;

    for (let i = 0; i < Math.min(entries.length, maxEntries); i++) {
      const entry = entries[i]!;
      const indent = '  '.repeat(entry.depth);
      const time = toIso(entry.event.timestamp);
      const groupTag = entry.groupId ? ` [group:${entry.groupId.slice(0, 8)}]` : '';
      lines.push(`${i + 1}. ${indent}\`${time}\` **${entry.event.source}**${groupTag} — ${this.describeEvent(entry.event)}`);
    }

    if (entries.length > maxEntries) {
      lines.push(``, `_…and ${entries.length - maxEntries} more events_`);
    }

    return lines.join('\n');
  }

  private renderNetworkRequests(data: ReportData, options?: ReportOptions): string {
    const requests: RequestEvent[] = [];
    const responses = new Map<string, ResponseEvent>();

    for (const entry of data.timeline.entries) {
      if (isRequestEvent(entry.event)) requests.push(entry.event as RequestEvent);
      if (isResponseEvent(entry.event)) {
        const res = entry.event as ResponseEvent;
        responses.set(res.requestId, res);
      }
    }

    if (requests.length === 0) return '';

    const lines: string[] = [
      `## Network Requests`,
      '',
      `| Method | URL | Status | Duration |`,
      `|--------|-----|--------|----------|`,
    ];

    for (const req of requests) {
      const res = responses.get(req.requestId);
      const status = res ? `${res.statusCode}` : 'pending';
      const duration = res ? formatDuration(res.duration) : '—';
      const url = req.url.length > 80 ? req.url.slice(0, 77) + '...' : req.url;
      lines.push(`| ${req.method} | \`${url}\` | ${status} | ${duration} |`);
    }

    if (options?.includeRequestBodies) {
      lines.push('', '### Request/Response Bodies', '');
      for (const req of requests) {
        if (req.body) {
          lines.push(`**${req.method} ${req.url}** — Request Body:`, '```json', req.body, '```', '');
        }
        const res = responses.get(req.requestId);
        if (res?.body) {
          lines.push(`**${req.method} ${req.url}** — Response Body:`, '```json', res.body, '```', '');
        }
      }
    }

    return lines.join('\n');
  }

  private renderErrors(data: ReportData): string {
    const errors: ProbeEvent[] = [];
    for (const entry of data.timeline.entries) {
      const e = entry.event;
      if (isBrowserEvent(e) && (e as ProbeEvent & { type?: string }).type === 'error') {
        errors.push(e);
      }
      if (isLogEvent(e)) {
        const log = e as LogEvent;
        if (log.level === 'error' || log.level === 'fatal') errors.push(e);
      }
      if (isResponseEvent(e) && (e as ResponseEvent).statusCode >= 400) {
        errors.push(e);
      }
    }

    if (errors.length === 0) return '';

    const lines: string[] = [`## Errors (${errors.length})`, ''];

    for (const error of errors) {
      lines.push(`### ${toIso(error.timestamp)} — ${error.source}`);

      if (isBrowserEvent(error)) {
        const be = error as unknown as BrowserErrorEvent;
        lines.push(``, `**${be.errorType}**: ${be.message}`);
        if (be.stack) {
          lines.push('```', be.stack, '```');
        }
      } else if (isLogEvent(error)) {
        const log = error as LogEvent;
        lines.push(``, `**[${log.level.toUpperCase()}]** ${log.message}`);
        if (log.stackTrace) {
          lines.push('```', log.stackTrace, '```');
        }
      } else if (isResponseEvent(error)) {
        const res = error as ResponseEvent;
        lines.push(``, `**HTTP ${res.statusCode}** ${res.statusText}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private renderCorrelationGroups(data: ReportData, _options?: ReportOptions): string {
    if (data.correlationGroups.length === 0) return '';

    const lines: string[] = [`## Correlation Groups (${data.correlationGroups.length})`, ''];

    for (const group of data.correlationGroups) {
      const s = group.summary;
      lines.push(`### Group \`${group.id.slice(0, 8)}\``);
      lines.push(`- **Trigger**: ${s.trigger ?? 'unknown'}`);
      if (s.httpMethod) lines.push(`- **HTTP**: ${s.httpMethod} ${s.httpUrl ?? ''} → ${s.httpStatus ?? 'pending'}`);
      if (s.totalDuration != null) lines.push(`- **Duration**: ${formatDuration(s.totalDuration)}`);
      lines.push(`- **Events**: ${group.events.length} | Logs: ${s.logCount} | DB Queries: ${s.dbQueryCount}`);
      if (s.hasError) lines.push(`- **Errors**: ${s.errorMessages.join('; ')}`);
      if (s.entitiesInvolved.length) lines.push(`- **Entities**: ${s.entitiesInvolved.join(', ')}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  private renderLogs(data: ReportData): string {
    const logs: LogEvent[] = [];
    for (const entry of data.timeline.entries) {
      if (isLogEvent(entry.event)) logs.push(entry.event as LogEvent);
    }

    if (logs.length === 0) return '';

    const levelBadge = (level: string): string => {
      const badges: Record<string, string> = {
        trace: '🔍', debug: '🐛', info: 'ℹ️',
        warn: '⚠️', error: '❌', fatal: '💀',
      };
      return badges[level] ?? level;
    };

    const lines: string[] = [`## Logs (${logs.length})`, ''];
    for (const log of logs) {
      lines.push(`- ${levelBadge(log.level)} \`${toIso(log.timestamp)}\` **[${log.level.toUpperCase()}]** ${log.message}`);
    }

    return lines.join('\n');
  }

  private renderFooter(): string {
    return `---\n_Generated by Debug Probe at ${toIso(Date.now())}_`;
  }

  // ---- Helpers ----

  private describeEvent(event: ProbeEvent): string {
    const e = event as unknown as Record<string, unknown>;
    switch (event.source) {
      case 'browser':
        if (e['type'] === 'click') return `click on \`${e['selector']}\``;
        if (e['type'] === 'navigation') return `navigate to ${e['toUrl']}`;
        if (e['type'] === 'screenshot') return `screenshot "${e['label'] ?? e['trigger']}"`;
        if (e['type'] === 'error') return `error: ${e['message']}`;
        if (e['type'] === 'console') return `console.${e['level']}: ${e['message']}`;
        return `browser:${e['type']}`;
      case 'network':
        if (e['type'] === 'request') return `${e['method']} ${e['url']}`;
        if (e['type'] === 'response') return `${e['statusCode']} (${formatDuration(e['duration'] as number)})`;
        return `network:${e['type']}`;
      case 'log':
        return `[${(e['level'] as string).toUpperCase()}] ${(e['message'] as string).slice(0, 100)}`;
      case 'sdk':
        if (e['type'] === 'db-query') return `DB: ${(e['query'] as string).slice(0, 80)}`;
        if (e['type'] === 'request-start') return `SDK req start: ${e['method']} ${e['url']}`;
        if (e['type'] === 'request-end') return `SDK req end: ${e['statusCode']} (${formatDuration(e['duration'] as number)})`;
        return `sdk:${e['type']}`;
      default:
        return event.source;
    }
  }
}
