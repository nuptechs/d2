// ============================================================
// Container — Factory for creating LogSourcePort adapters
// Selects adapter based on config.source.type
// ============================================================

import type { LogCollectorConfig } from '@probe/core';
import type { LogSourcePort } from '@probe/core/ports';
import { FileLogAdapter } from './adapters/file.adapter.js';
import { DockerLogAdapter } from './adapters/docker.adapter.js';
import { StdoutLogAdapter } from './adapters/stdout.adapter.js';

/**
 * Creates the appropriate log source adapter based on `config.source.type`.
 * For 'stdout' and 'stderr', a Node.js Readable stream must be provided.
 */
export function createLogSource(
  config: LogCollectorConfig,
  stream?: NodeJS.ReadableStream,
): LogSourcePort {
  switch (config.source.type) {
    case 'file':
      return new FileLogAdapter();

    case 'docker':
      return new DockerLogAdapter();

    case 'stdout':
    case 'stderr': {
      const readable = stream ?? (config.source.type === 'stdout' ? process.stdout : process.stderr);
      if (!readable || typeof (readable as NodeJS.ReadableStream).on !== 'function') {
        throw new Error(`StdoutLogAdapter requires a Readable stream for '${config.source.type}'`);
      }
      return new StdoutLogAdapter(readable as import('node:stream').Readable);
    }

    default:
      throw new Error(`Unsupported log source type: '${config.source.type}'`);
  }
}

/**
 * Creates multiple log source adapters from an array of configs.
 */
export function createMultiLogCollector(
  configs: LogCollectorConfig[],
  streams?: Map<string, NodeJS.ReadableStream>,
): LogSourcePort[] {
  return configs
    .filter(c => c.enabled)
    .map(config => {
      const stream = streams?.get(config.source.name);
      return createLogSource(config, stream);
    });
}
