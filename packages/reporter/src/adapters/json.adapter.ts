// ============================================================
// JSON Reporter — Structured JSON output with optional filtering
// ============================================================

import { ReporterPort, type ReportData, type ReportOptions } from '@probe/core';
import type { ProbeEvent } from '@probe/core';
import { isBrowserEvent, isRequestEvent, isResponseEvent } from '@probe/core';

export class JsonReporter extends ReporterPort {
  async generate(data: ReportData, options?: ReportOptions): Promise<string> {
    const filtered = this.applyFilters(data, options);
    return JSON.stringify(filtered, null, 2);
  }

  getFormat(): string { return 'json'; }
  getMimeType(): string { return 'application/json'; }
  getFileExtension(): string { return 'json'; }

  private applyFilters(data: ReportData, options?: ReportOptions): ReportData {
    if (!options) return data;

    const filterEvents = (events: readonly ProbeEvent[]): ProbeEvent[] =>
      events.map((event) => {
        let filtered = event;

        if (!options.includeScreenshots && isBrowserEvent(event)) {
          const be = event as ProbeEvent & { type?: string; data?: string };
          if (be.type === 'screenshot') {
            const { data: _data, ...rest } = event as unknown as Record<string, unknown>;
            filtered = { ...rest, data: '[screenshot omitted]' } as unknown as ProbeEvent;
          }
        }

        if (!options.includeRequestBodies) {
          if (isRequestEvent(event)) {
            const { body: _body, ...rest } = event as unknown as Record<string, unknown>;
            filtered = { ...rest } as unknown as ProbeEvent;
          }
          if (isResponseEvent(event)) {
            const { body: _body, ...rest } = event as unknown as Record<string, unknown>;
            filtered = { ...rest } as unknown as ProbeEvent;
          }
        }

        return filtered;
      });

    return {
      session: data.session,
      timeline: {
        ...data.timeline,
        entries: data.timeline.entries.map((entry) => ({
          ...entry,
          event: filterEvents([entry.event])[0]!,
        })),
      },
      correlationGroups: data.correlationGroups.map((group) => ({
        ...group,
        events: options.maxEventsPerGroup
          ? filterEvents(group.events).slice(0, options.maxEventsPerGroup)
          : filterEvents(group.events),
      })),
    };
  }
}
