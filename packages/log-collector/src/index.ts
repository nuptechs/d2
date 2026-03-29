// ============================================================
// @probe/log-collector — Public API
// ============================================================

// Adapters
export { FileLogAdapter } from './adapters/file.adapter.js';
export { DockerLogAdapter } from './adapters/docker.adapter.js';
export { StdoutLogAdapter } from './adapters/stdout.adapter.js';

// Parser
export { parseLogLine, LogParser } from './parser/log-parser.js';
export { detectLogFormat, LOG_PATTERNS, LEVEL_MAP } from './parser/patterns.js';

// Container (factory)
export { createLogSource, createMultiLogCollector } from './container.js';
