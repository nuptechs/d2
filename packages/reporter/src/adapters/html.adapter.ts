// ============================================================
// HTML Reporter — Self-contained HTML debug report
// ============================================================

import { ReporterPort, type ReportData, type ReportOptions } from '@probe/core';
import type {
  ProbeEvent,
  RequestEvent,
  ResponseEvent,
  LogEvent,
  BrowserErrorEvent,
  ScreenshotEvent,
} from '@probe/core';
import {
  formatDuration,
  toIso,
  isRequestEvent,
  isResponseEvent,
  isLogEvent,
  isBrowserEvent,
  isScreenshotEvent,
} from '@probe/core';

export class HtmlReporter extends ReporterPort {
  async generate(data: ReportData, options?: ReportOptions): Promise<string> {
    const title = options?.title ?? `Debug Report — ${data.session.name}`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
${this.renderStyles()}
</head>
<body>
${this.renderHeaderSection(title, data)}
${this.renderSummaryCards(data)}
${this.renderTimelineSection(data, options)}
${this.renderCorrelationGroupsSection(data, options)}
${options?.includeScreenshots !== false ? this.renderScreenshotsGallery(data) : ''}
${this.renderErrorsSection(data)}
${this.renderNetworkSection(data, options)}
${options?.includeLogLines !== false ? this.renderLogSection(data) : ''}
${this.renderFooter()}
<script>${this.renderScript()}</script>
</body>
</html>`;
  }

  getFormat(): string { return 'html'; }
  getMimeType(): string { return 'text/html'; }
  getFileExtension(): string { return 'html'; }

  // ---- CSS ----

  private renderStyles(): string {
    return `<style>
:root {
  --bg: #1e1e1e; --bg-card: #252526; --bg-hover: #2a2d2e;
  --fg: #cccccc; --fg-dim: #858585; --fg-bright: #ffffff;
  --accent: #569cd6; --accent-dim: #264f78;
  --green: #4ec9b0; --yellow: #dcdcaa; --orange: #ce9178;
  --red: #f44747; --pink: #c586c0;
  --border: #3c3c3c; --radius: 6px;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Segoe UI', -apple-system, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.6; padding: 24px; max-width: 1400px; margin: 0 auto; }
h1 { color: var(--fg-bright); font-size: 1.8rem; margin-bottom: 8px; }
h2 { color: var(--accent); font-size: 1.3rem; margin: 32px 0 12px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
h3 { color: var(--fg-bright); font-size: 1.05rem; margin: 16px 0 8px; }
a { color: var(--accent); text-decoration: none; }

.header { margin-bottom: 24px; }
.header .meta { color: var(--fg-dim); font-size: 0.9rem; }
.header .meta span { margin-right: 16px; }

.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
.card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
.card .label { color: var(--fg-dim); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.5px; }
.card .value { color: var(--fg-bright); font-size: 1.6rem; font-weight: 600; margin-top: 4px; }
.card .value.error { color: var(--red); }
.card .value.success { color: var(--green); }

.timeline { position: relative; padding-left: 24px; }
.timeline::before { content: ''; position: absolute; left: 8px; top: 0; bottom: 0; width: 2px; background: var(--border); }
.tl-entry { position: relative; margin-bottom: 6px; padding: 6px 12px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); font-size: 0.85rem; cursor: pointer; transition: background 0.15s; }
.tl-entry:hover { background: var(--bg-hover); }
.tl-entry::before { content: ''; position: absolute; left: -20px; top: 14px; width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--accent); background: var(--bg); }
.tl-entry[data-source="browser"]::before { border-color: var(--green); }
.tl-entry[data-source="network"]::before { border-color: var(--accent); }
.tl-entry[data-source="sdk"]::before { border-color: var(--yellow); }
.tl-entry[data-source="log"]::before { border-color: var(--orange); }
.tl-entry .time { color: var(--fg-dim); margin-right: 8px; font-family: monospace; font-size: 0.8rem; }
.tl-entry .source { font-weight: 600; margin-right: 6px; }
.tl-entry .desc { color: var(--fg); }

.group-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 12px; overflow: hidden; }
.group-header { padding: 12px 16px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
.group-header:hover { background: var(--bg-hover); }
.group-header .title { font-weight: 600; color: var(--fg-bright); }
.group-header .badge { font-size: 0.75rem; padding: 2px 8px; border-radius: 10px; background: var(--accent-dim); color: var(--accent); }
.group-header .badge.error { background: rgba(244,71,71,0.15); color: var(--red); }
.group-body { padding: 0 16px 12px; display: none; border-top: 1px solid var(--border); }
.group-body.open { display: block; padding-top: 12px; }
.group-meta { display: flex; gap: 16px; flex-wrap: wrap; font-size: 0.85rem; color: var(--fg-dim); margin-bottom: 8px; }

.screenshots { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.screenshot { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.screenshot img { width: 100%; display: block; }
.screenshot .caption { padding: 6px 10px; font-size: 0.8rem; color: var(--fg-dim); }

.error-entry { background: rgba(244,71,71,0.08); border: 1px solid rgba(244,71,71,0.25); border-radius: var(--radius); padding: 12px 16px; margin-bottom: 8px; }
.error-entry .msg { color: var(--red); font-weight: 600; }
.error-entry pre { background: var(--bg); padding: 8px; border-radius: 4px; overflow-x: auto; font-size: 0.8rem; margin-top: 8px; color: var(--fg-dim); }

table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
th { text-align: left; color: var(--fg-dim); border-bottom: 1px solid var(--border); padding: 8px 12px; font-weight: 600; }
td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
tr:hover td { background: var(--bg-hover); }

.status { font-weight: 600; }
.status.s2xx { color: var(--green); }
.status.s3xx { color: var(--accent); }
.status.s4xx { color: var(--orange); }
.status.s5xx { color: var(--red); }

.log-entry { font-family: monospace; font-size: 0.8rem; padding: 3px 8px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; }
.log-entry:hover { background: var(--bg-hover); }
.log-entry .lvl { font-weight: 700; min-width: 50px; }
.log-entry .lvl.trace { color: var(--fg-dim); }
.log-entry .lvl.debug { color: var(--fg-dim); }
.log-entry .lvl.info { color: var(--accent); }
.log-entry .lvl.warn { color: var(--yellow); }
.log-entry .lvl.error { color: var(--red); }
.log-entry .lvl.fatal { color: var(--red); font-weight: 900; }

.footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--fg-dim); font-size: 0.8rem; text-align: center; }

@media print {
  body { background: #fff; color: #222; padding: 12px; }
  .card { border: 1px solid #ccc; }
  .tl-entry, .group-card, .error-entry { break-inside: avoid; }
  .group-body { display: block !important; }
}
</style>`;
  }

  // ---- Header ----

  private renderHeaderSection(title: string, data: ReportData): string {
    const s = data.session;
    const duration = s.endedAt ? formatDuration(s.endedAt - s.startedAt) : 'ongoing';
    return `<div class="header">
  <h1>${esc(title)}</h1>
  <div class="meta">
    <span>Session: <strong>${esc(s.id.slice(0, 12))}</strong></span>
    <span>Status: <strong>${esc(s.status)}</strong></span>
    <span>Started: <strong>${toIso(s.startedAt)}</strong></span>
    <span>Duration: <strong>${esc(duration)}</strong></span>
  </div>
</div>`;
  }

  // ---- Summary Cards ----

  private renderSummaryCards(data: ReportData): string {
    const st = data.timeline.stats;
    const avgResp = st.avgResponseTime !== undefined ? formatDuration(st.avgResponseTime) : '—';
    const errClass = st.errors > 0 ? ' error' : ' success';
    return `<div class="cards">
  <div class="card"><div class="label">Total Events</div><div class="value">${st.totalEvents}</div></div>
  <div class="card"><div class="label">Correlation Groups</div><div class="value">${st.correlationGroups}</div></div>
  <div class="card"><div class="label">Errors</div><div class="value${errClass}">${st.errors}</div></div>
  <div class="card"><div class="label">Avg Response Time</div><div class="value">${esc(avgResp)}</div></div>
</div>`;
  }

  // ---- Timeline ----

  private renderTimelineSection(data: ReportData, options?: ReportOptions): string {
    const entries = data.timeline.entries;
    if (entries.length === 0) return '';

    const max = options?.maxEventsPerGroup ?? 500;
    const shown = entries.slice(0, max);
    let html = `<h2>Timeline (${entries.length} events)</h2>\n<div class="timeline">\n`;

    for (const entry of shown) {
      const depth = entry.depth;
      const ml = depth * 24;
      html += `<div class="tl-entry" data-source="${esc(entry.event.source)}" style="margin-left:${ml}px">
  <span class="time">${toIso(entry.event.timestamp).slice(11, 23)}</span>
  <span class="source">${esc(entry.event.source)}</span>
  <span class="desc">${esc(this.describeEvent(entry.event))}</span>
</div>\n`;
    }

    if (entries.length > max) {
      html += `<div style="padding:8px;color:var(--fg-dim);font-size:0.85rem">…and ${entries.length - max} more events</div>\n`;
    }

    html += `</div>`;
    return html;
  }

  // ---- Correlation Groups ----

  private renderCorrelationGroupsSection(data: ReportData, options?: ReportOptions): string {
    if (data.correlationGroups.length === 0) return '';

    let html = `<h2>Correlation Groups (${data.correlationGroups.length})</h2>\n`;

    for (const group of data.correlationGroups) {
      const s = group.summary;
      const errBadge = s.hasError ? ' error' : '';
      const eventLimit = options?.maxEventsPerGroup ?? group.events.length;
      const shownEvents = group.events.slice(0, eventLimit);

      html += `<div class="group-card">
  <div class="group-header" onclick="this.nextElementSibling.classList.toggle('open')">
    <span class="title">${esc(s.trigger ?? 'Group')} — ${esc(group.id.slice(0, 8))}</span>
    <span class="badge${errBadge}">${group.events.length} events</span>
  </div>
  <div class="group-body">
    <div class="group-meta">
      ${s.httpMethod ? `<span>${esc(s.httpMethod)} ${esc(s.httpUrl ?? '')} → ${s.httpStatus ?? '?'}</span>` : ''}
      ${s.totalDuration != null ? `<span>Duration: ${esc(formatDuration(s.totalDuration))}</span>` : ''}
      <span>Logs: ${s.logCount}</span>
      <span>DB Queries: ${s.dbQueryCount}</span>
    </div>
    <table>
      <thead><tr><th>Time</th><th>Source</th><th>Description</th></tr></thead>
      <tbody>`;

      for (const event of shownEvents) {
        html += `<tr>
          <td style="font-family:monospace;font-size:0.8rem">${toIso(event.timestamp).slice(11, 23)}</td>
          <td>${esc(event.source)}</td>
          <td>${esc(this.describeEvent(event))}</td>
        </tr>`;
      }

      html += `</tbody></table></div></div>\n`;
    }

    return html;
  }

  // ---- Screenshots ----

  private renderScreenshotsGallery(data: ReportData): string {
    const screenshots: ScreenshotEvent[] = [];
    for (const entry of data.timeline.entries) {
      if (isScreenshotEvent(entry.event)) {
        screenshots.push(entry.event as ScreenshotEvent);
      }
    }

    if (screenshots.length === 0) return '';

    let html = `<h2>Screenshots (${screenshots.length})</h2>\n<div class="screenshots">\n`;

    for (const ss of screenshots) {
      const label = ss.label ?? ss.trigger;
      html += `<div class="screenshot">
  <img src="data:image/png;base64,${ss.data}" alt="${esc(label)}" loading="lazy" />
  <div class="caption">${esc(label)} — ${toIso(ss.timestamp).slice(11, 23)}</div>
</div>\n`;
    }

    html += `</div>`;
    return html;
  }

  // ---- Errors ----

  private renderErrorsSection(data: ReportData): string {
    const errors: ProbeEvent[] = [];
    for (const entry of data.timeline.entries) {
      const e = entry.event;
      if (isBrowserEvent(e) && (e as ProbeEvent & { type?: string }).type === 'error') errors.push(e);
      if (isLogEvent(e) && ((e as LogEvent).level === 'error' || (e as LogEvent).level === 'fatal')) errors.push(e);
      if (isResponseEvent(e) && (e as ResponseEvent).statusCode >= 400) errors.push(e);
    }

    if (errors.length === 0) return '';

    let html = `<h2>Errors (${errors.length})</h2>\n`;

    for (const error of errors) {
      if (isBrowserEvent(error)) {
        const be = error as unknown as BrowserErrorEvent;
        html += `<div class="error-entry">
  <div class="msg">[${esc(be.errorType)}] ${esc(be.message)}</div>
  ${be.stack ? `<pre>${esc(be.stack)}</pre>` : ''}
</div>\n`;
      } else if (isLogEvent(error)) {
        const log = error as LogEvent;
        html += `<div class="error-entry">
  <div class="msg">[${esc(log.level.toUpperCase())}] ${esc(log.message)}</div>
  ${log.stackTrace ? `<pre>${esc(log.stackTrace)}</pre>` : ''}
</div>\n`;
      } else if (isResponseEvent(error)) {
        const res = error as ResponseEvent;
        html += `<div class="error-entry">
  <div class="msg">HTTP ${res.statusCode} ${esc(res.statusText)}</div>
</div>\n`;
      }
    }

    return html;
  }

  // ---- Network ----

  private renderNetworkSection(data: ReportData, options?: ReportOptions): string {
    const requests: RequestEvent[] = [];
    const responses = new Map<string, ResponseEvent>();

    for (const entry of data.timeline.entries) {
      if (isRequestEvent(entry.event)) requests.push(entry.event as RequestEvent);
      if (isResponseEvent(entry.event)) responses.set((entry.event as ResponseEvent).requestId, entry.event as ResponseEvent);
    }

    if (requests.length === 0) return '';

    let html = `<h2>Network Trace (${requests.length} requests)</h2>
<table>
  <thead><tr><th>Method</th><th>URL</th><th>Status</th><th>Duration</th><th>Size</th></tr></thead>
  <tbody>\n`;

    for (const req of requests) {
      const res = responses.get(req.requestId);
      const status = res ? res.statusCode : 0;
      const statusClass = status >= 500 ? 's5xx' : status >= 400 ? 's4xx' : status >= 300 ? 's3xx' : 's2xx';
      const duration = res ? formatDuration(res.duration) : '—';
      const size = res?.bodySize != null ? `${(res.bodySize / 1024).toFixed(1)}KB` : '—';
      const url = req.url.length > 100 ? req.url.slice(0, 97) + '...' : req.url;

      html += `<tr>
  <td><strong>${esc(req.method)}</strong></td>
  <td style="font-family:monospace;font-size:0.8rem;word-break:break-all">${esc(url)}</td>
  <td class="status ${statusClass}">${status || 'pending'}</td>
  <td>${esc(duration)}</td>
  <td>${esc(size)}</td>
</tr>\n`;
    }

    html += `</tbody></table>`;

    if (options?.includeRequestBodies) {
      for (const req of requests) {
        if (req.body) {
          html += `<h3>${esc(req.method)} ${esc(req.url.slice(0, 80))} — Request</h3><pre>${esc(req.body)}</pre>`;
        }
        const res = responses.get(req.requestId);
        if (res?.body) {
          html += `<h3>${esc(req.method)} ${esc(req.url.slice(0, 80))} — Response</h3><pre>${esc(res.body)}</pre>`;
        }
      }
    }

    return html;
  }

  // ---- Logs ----

  private renderLogSection(data: ReportData): string {
    const logs: LogEvent[] = [];
    for (const entry of data.timeline.entries) {
      if (isLogEvent(entry.event)) logs.push(entry.event as LogEvent);
    }

    if (logs.length === 0) return '';

    let html = `<h2>Logs (${logs.length})</h2>\n<div>\n`;

    for (const log of logs) {
      html += `<div class="log-entry">
  <span class="lvl ${log.level}">${esc(log.level.toUpperCase())}</span>
  <span style="color:var(--fg-dim);min-width:90px">${toIso(log.timestamp).slice(11, 23)}</span>
  <span>${esc(log.message)}</span>
</div>\n`;
    }

    html += `</div>`;
    return html;
  }

  // ---- Footer ----

  private renderFooter(): string {
    return `<div class="footer">Generated by Debug Probe at ${toIso(Date.now())}</div>`;
  }

  // ---- Script (collapsible groups) ----

  private renderScript(): string {
    return `
document.querySelectorAll('.group-header').forEach(function(el) {
  el.addEventListener('click', function() {
    this.nextElementSibling.classList.toggle('open');
  });
});`;
  }

  // ---- Describe event ----

  private describeEvent(event: ProbeEvent): string {
    const e = event as unknown as Record<string, unknown>;
    switch (event.source) {
      case 'browser':
        if (e['type'] === 'click') return `click on ${e['selector']}`;
        if (e['type'] === 'navigation') return `navigate → ${e['toUrl']}`;
        if (e['type'] === 'screenshot') return `screenshot "${e['label'] ?? e['trigger']}"`;
        if (e['type'] === 'error') return `${e['message']}`;
        if (e['type'] === 'console') return `console.${e['level']}: ${e['message']}`;
        return `browser:${e['type']}`;
      case 'network':
        if (e['type'] === 'request') return `${e['method']} ${e['url']}`;
        if (e['type'] === 'response') return `${e['statusCode']} (${formatDuration(e['duration'] as number)})`;
        return `network:${e['type']}`;
      case 'log':
        return `[${(e['level'] as string).toUpperCase()}] ${(e['message'] as string).slice(0, 120)}`;
      case 'sdk':
        if (e['type'] === 'db-query') return `DB: ${(e['query'] as string).slice(0, 80)}`;
        if (e['type'] === 'request-start') return `req start: ${e['method']} ${e['url']}`;
        if (e['type'] === 'request-end') return `req end: ${e['statusCode']} (${formatDuration(e['duration'] as number)})`;
        return `sdk:${e['type']}`;
      default:
        return event.source;
    }
  }
}

// ---- HTML Escaping ----

function esc(value: unknown): string {
  const str = String(value ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
