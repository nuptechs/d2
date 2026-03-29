// ============================================================
// Debug Probe — Session & Component Configuration Types
// ============================================================

import type { LogLevel, LogSourceInfo } from './events.js';

// ---- Session Types ----

export type SessionStatus = 'idle' | 'capturing' | 'paused' | 'completed' | 'error';

export interface DebugSession {
  id: string;
  name: string;
  status: SessionStatus;
  config: SessionConfig;
  startedAt: number;
  endedAt?: number;
  eventCount: number;
  errorMessage?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface SessionConfig {
  browser?: BrowserConfig;
  logs?: LogCollectorConfig[];
  network?: NetworkConfig;
  sdk?: SdkConfig;
  correlation?: CorrelationConfig;
  capture?: CaptureConfig;
}

// ---- Browser Configuration ----

export interface BrowserConfig {
  enabled: boolean;
  targetUrl: string;
  screenshotOnAction: boolean;
  screenshotInterval?: number;
  captureConsole: boolean;
  captureDom: boolean;
  viewport?: { width: number; height: number };
  headless?: boolean;
  userAgent?: string;
  cookies?: ReadonlyArray<{ name: string; value: string; domain: string }>;
}

// ---- Log Collector Configuration ----

export interface LogCollectorConfig {
  enabled: boolean;
  source: LogSourceInfo;
  patterns?: string[];
  levels?: LogLevel[];
  encoding?: string;
}

// ---- Network Configuration ----

export interface NetworkConfig {
  enabled: boolean;
  mode: 'proxy' | 'middleware' | 'browser';
  proxyPort?: number;
  captureBody: boolean;
  maxBodySize?: number;
  includeUrls?: string[];
  excludeUrls?: string[];
  excludeExtensions?: string[];
}

// ---- SDK Configuration ----

export interface SdkConfig {
  enabled: boolean;
  captureDbQueries: boolean;
  captureCache: boolean;
  captureCustomSpans: boolean;
  correlationHeader: string;
  sensitiveHeaders?: string[];
  redactPatterns?: string[];
}

// ---- Correlation Configuration ----

export type CorrelationStrategyType =
  | 'request-id'
  | 'temporal'
  | 'url-matching'
  | 'trace-id';

export interface CorrelationConfig {
  strategies: CorrelationStrategyType[];
  temporalWindowMs: number;
  correlationHeader: string;
  groupTimeoutMs: number;
}

// ---- Capture Limits ----

export interface CaptureConfig {
  maxEventsPerSession: number;
  maxScreenshots: number;
  maxBodyCaptureSize: number;
  redactHeaders: string[];
  redactBodyFields: string[];
}

// ---- Defaults ----

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  maxEventsPerSession: 50_000,
  maxScreenshots: 500,
  maxBodyCaptureSize: 1_048_576,
  redactHeaders: ['authorization', 'cookie', 'set-cookie', 'x-api-key'],
  redactBodyFields: ['password', 'secret', 'token', 'creditCard', 'ssn'],
};

export const DEFAULT_CORRELATION_CONFIG: CorrelationConfig = {
  strategies: ['request-id', 'temporal', 'url-matching'],
  temporalWindowMs: 2_000,
  correlationHeader: 'x-probe-correlation-id',
  groupTimeoutMs: 30_000,
};

export const DEFAULT_SDK_CONFIG: SdkConfig = {
  enabled: true,
  captureDbQueries: true,
  captureCache: true,
  captureCustomSpans: true,
  correlationHeader: 'x-probe-correlation-id',
  sensitiveHeaders: ['authorization', 'cookie'],
  redactPatterns: ['password', 'secret', 'token'],
};

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  enabled: true,
  targetUrl: 'http://localhost:3000',
  screenshotOnAction: true,
  captureConsole: true,
  captureDom: false,
  headless: false,
  viewport: { width: 1280, height: 720 },
};

export const DEFAULT_NETWORK_CONFIG: NetworkConfig = {
  enabled: true,
  mode: 'proxy',
  captureBody: true,
  maxBodySize: 1_048_576,
  excludeExtensions: ['.css', '.js', '.png', '.jpg', '.gif', '.svg', '.woff', '.woff2', '.ico'],
};
