// ============================================================
// ReporterPort — Abstraction for debug report generation
// Adapters: HTML, JSON, Markdown
// ============================================================

import type { DebugSession, Timeline, CorrelationGroup } from '../types/index.js';

export interface ReportData {
  session: DebugSession;
  timeline: Timeline;
  correlationGroups: CorrelationGroup[];
}

export interface ReportOptions {
  includeScreenshots?: boolean;
  includeRequestBodies?: boolean;
  includeLogLines?: boolean;
  maxEventsPerGroup?: number;
  title?: string;
}

export abstract class ReporterPort {
  abstract generate(data: ReportData, options?: ReportOptions): Promise<string>;
  abstract getFormat(): string;
  abstract getMimeType(): string;
  abstract getFileExtension(): string;
}
