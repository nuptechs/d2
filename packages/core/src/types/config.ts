// ============================================================
// Debug Probe — Top-Level Configuration Types
// ============================================================

import type { SessionConfig } from './session.js';

/** Top-level configuration for a Debug Probe instance */
export interface ProbeConfig {
  projectName: string;
  outputDir: string;
  session: SessionConfig;
  server?: ServerConfig;
  storage?: StorageConfig;
}

/** API server configuration */
export interface ServerConfig {
  port: number;
  host: string;
  corsOrigins?: string[];
  enableWebSocket: boolean;
}

/** Session storage configuration */
export interface StorageConfig {
  type: 'file' | 'memory';
  basePath?: string;
  maxSessions?: number;
  maxStorageMb?: number;
}

// ---- Defaults ----

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  port: 7070,
  host: '0.0.0.0',
  corsOrigins: ['http://localhost:*'],
  enableWebSocket: true,
};

export const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  type: 'file',
  basePath: '.probe-data',
  maxSessions: 100,
  maxStorageMb: 512,
};

export const DEFAULT_PROBE_CONFIG: ProbeConfig = {
  projectName: 'debug-session',
  outputDir: '.probe-data',
  session: {},
  server: DEFAULT_SERVER_CONFIG,
  storage: DEFAULT_STORAGE_CONFIG,
};
