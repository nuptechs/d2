// ============================================================
// Container — Factory for report generators
// ============================================================

import { ReporterPort } from '@probe/core';
import { HtmlReporter } from './adapters/html.adapter.js';
import { JsonReporter } from './adapters/json.adapter.js';
import { MarkdownReporter } from './adapters/markdown.adapter.js';

export type ReportFormat = 'html' | 'json' | 'markdown';

const FORMATS: Record<ReportFormat, () => ReporterPort> = {
  html: () => new HtmlReporter(),
  json: () => new JsonReporter(),
  markdown: () => new MarkdownReporter(),
};

export function createReporter(format: ReportFormat): ReporterPort {
  const factory = FORMATS[format];
  if (!factory) {
    throw new Error(`Unknown report format: ${format}. Available: ${getAvailableFormats().join(', ')}`);
  }
  return factory();
}

export function getAvailableFormats(): string[] {
  return Object.keys(FORMATS);
}
