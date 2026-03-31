// ============================================================
// Storage — Factory + re-exports
// ============================================================

export { FileStorageAdapter } from './file-storage.adapter.js';
export { MemoryStorageAdapter } from './memory-storage.adapter.js';
export { PostgresStorageAdapter, StorageCircuitBreaker, isTransientError, type PostgresStorageConfig } from './postgres-storage.adapter.js';
export { StoragePort, type EventFilter } from '../ports/storage.port.js';

import type { StorageConfig } from '../types/config.js';
import type { StoragePort } from '../ports/storage.port.js';
import { FileStorageAdapter } from './file-storage.adapter.js';
import { MemoryStorageAdapter } from './memory-storage.adapter.js';
import { PostgresStorageAdapter } from './postgres-storage.adapter.js';

export function createStorage(config: StorageConfig): StoragePort {
  if (config.type === 'postgres') {
    return new PostgresStorageAdapter({
      connectionString: config.connectionString,
      host: config.host,
      port: config.pgPort,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl,
    });
  }
  if (config.type === 'file') {
    return new FileStorageAdapter(config.basePath ?? '.probe-data');
  }
  return new MemoryStorageAdapter();
}
