// ============================================================
// @probe/correlation-engine — Public API
// ============================================================

export { EventCorrelator } from './correlator.js';
export { createCorrelator } from './container.js';

// Strategies (for advanced usage / extension)
export { CorrelationStrategy } from './strategies/base.strategy.js';
export { RequestIdStrategy } from './strategies/request-id.strategy.js';
export { TemporalStrategy } from './strategies/temporal.strategy.js';
export { UrlMatchingStrategy } from './strategies/url-matching.strategy.js';

// Builders
export { buildGroupSummary } from './summary-builder.js';
export { buildTimeline } from './timeline/timeline-builder.js';
