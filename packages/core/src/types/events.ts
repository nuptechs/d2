// ============================================================
// Debug Probe — Event Type Hierarchy
// All event types that flow through the system
// ============================================================

// ---- Foundational Types ----

/** Source system that generated the event */
export type EventSource = 'browser' | 'network' | 'log' | 'sdk' | 'correlation';

/** Base interface for all probe events — immutable after creation */
export interface ProbeEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly timestamp: number;
  readonly source: EventSource;
  readonly correlationId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================
// Browser Events
// ============================================================

export type BrowserEventType =
  | 'click'
  | 'navigation'
  | 'input'
  | 'screenshot'
  | 'dom-snapshot'
  | 'console'
  | 'error';

export interface BrowserEvent extends ProbeEvent {
  readonly source: 'browser';
  readonly type: BrowserEventType;
  readonly pageUrl: string;
}

export interface ClickEvent extends BrowserEvent {
  readonly type: 'click';
  readonly selector: string;
  readonly elementTag: string;
  readonly elementText?: string;
  readonly coordinates: Readonly<{ x: number; y: number }>;
}

export interface NavigationEvent extends BrowserEvent {
  readonly type: 'navigation';
  readonly fromUrl?: string;
  readonly toUrl: string;
  readonly timing?: Readonly<{
    domContentLoaded?: number;
    load?: number;
    firstPaint?: number;
    firstContentfulPaint?: number;
  }>;
}

export interface InputEvent extends BrowserEvent {
  readonly type: 'input';
  readonly selector: string;
  readonly elementTag: string;
  readonly inputType?: string;
  readonly value: string;
  readonly masked: boolean;
}

export interface ScreenshotEvent extends BrowserEvent {
  readonly type: 'screenshot';
  readonly data: string; // base64 PNG
  readonly viewport: Readonly<{ width: number; height: number }>;
  readonly trigger: ScreenshotTrigger;
  readonly label?: string;
}

export type ScreenshotTrigger =
  | 'manual'
  | 'pre-action'
  | 'post-action'
  | 'error'
  | 'periodic';

export interface DomSnapshotEvent extends BrowserEvent {
  readonly type: 'dom-snapshot';
  readonly html: string;
}

export interface ConsoleEvent extends BrowserEvent {
  readonly type: 'console';
  readonly level: 'log' | 'warn' | 'error' | 'info' | 'debug';
  readonly message: string;
  readonly args?: readonly unknown[];
}

export interface BrowserErrorEvent extends BrowserEvent {
  readonly type: 'error';
  readonly errorType: 'uncaught' | 'unhandled-rejection' | 'resource' | 'network';
  readonly message: string;
  readonly stack?: string;
  readonly fileName?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
}

// ============================================================
// Network Events
// ============================================================

export type NetworkEventType = 'request' | 'response';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface NetworkEvent extends ProbeEvent {
  readonly source: 'network';
  readonly type: NetworkEventType;
  readonly requestId: string;
}

export interface RequestEvent extends NetworkEvent {
  readonly type: 'request';
  readonly method: HttpMethod | string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly bodySize?: number;
  readonly initiator?: string;
}

export interface ResponseEvent extends NetworkEvent {
  readonly type: 'response';
  readonly statusCode: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly bodySize?: number;
  readonly duration: number; // ms from request start
}

// ============================================================
// Log Events
// ============================================================

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogSourceInfo {
  readonly type: 'file' | 'docker' | 'stdout' | 'stderr' | 'syslog';
  readonly name: string;
  readonly path?: string;
  readonly containerId?: string;
  readonly containerName?: string;
}

export interface LogEvent extends ProbeEvent {
  readonly source: 'log';
  readonly level: LogLevel;
  readonly message: string;
  readonly loggerName?: string;
  readonly threadName?: string;
  readonly sourceFile?: string;
  readonly sourceLine?: number;
  readonly stackTrace?: string;
  readonly structured?: Readonly<Record<string, unknown>>;
  readonly rawLine: string;
  readonly logSource: LogSourceInfo;
}

// ============================================================
// SDK Events (injected by instrumented application)
// ============================================================

export type SdkEventType =
  | 'request-start'
  | 'request-end'
  | 'db-query'
  | 'cache-op'
  | 'custom-span'
  | 'custom';

export interface SdkEvent extends ProbeEvent {
  readonly source: 'sdk';
  readonly type: SdkEventType;
}

export interface SdkRequestStartEvent extends SdkEvent {
  readonly type: 'request-start';
  readonly requestId: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly remoteAddress?: string;
}

export interface SdkRequestEndEvent extends SdkEvent {
  readonly type: 'request-end';
  readonly requestId: string;
  readonly statusCode: number;
  readonly duration: number;
  readonly error?: string;
}

export interface SdkDbQueryEvent extends SdkEvent {
  readonly type: 'db-query';
  readonly query: string;
  readonly params?: readonly unknown[];
  readonly duration: number;
  readonly rowCount?: number;
  readonly error?: string;
  readonly requestId?: string;
}

export interface SdkCacheEvent extends SdkEvent {
  readonly type: 'cache-op';
  readonly operation: 'get' | 'set' | 'del' | 'hit' | 'miss';
  readonly key: string;
  readonly duration: number;
  readonly requestId?: string;
}

export interface SdkCustomSpanEvent extends SdkEvent {
  readonly type: 'custom-span';
  readonly name: string;
  readonly duration: number;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly requestId?: string;
}

export interface SdkCustomEvent extends SdkEvent {
  readonly type: 'custom';
  readonly name: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

// ============================================================
// Correlation & Timeline Types
// ============================================================

export interface CorrelationGroup {
  readonly id: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly createdAt: number;
  readonly events: readonly ProbeEvent[];
  readonly summary: CorrelationSummary;
}

export interface CorrelationSummary {
  readonly trigger?: string;
  readonly httpMethod?: string;
  readonly httpUrl?: string;
  readonly httpStatus?: number;
  readonly totalDuration?: number;
  readonly hasScreenshot: boolean;
  readonly hasError: boolean;
  readonly errorMessages: readonly string[];
  readonly logCount: number;
  readonly dbQueryCount: number;
  readonly dbTotalDuration: number;
  readonly entitiesInvolved: readonly string[];
}

export interface TimelineEntry {
  readonly event: ProbeEvent;
  readonly depth: number;
  readonly groupId?: string;
}

export interface Timeline {
  readonly sessionId: string;
  readonly entries: readonly TimelineEntry[];
  readonly duration: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly stats: TimelineStats;
}

export interface TimelineStats {
  readonly totalEvents: number;
  readonly bySource: Readonly<Record<EventSource, number>>;
  readonly correlationGroups: number;
  readonly errors: number;
  readonly avgResponseTime?: number;
}

// ============================================================
// Union Types (for type guards and exhaustive matching)
// ============================================================

export type AnyBrowserEvent =
  | ClickEvent
  | NavigationEvent
  | InputEvent
  | ScreenshotEvent
  | DomSnapshotEvent
  | ConsoleEvent
  | BrowserErrorEvent;

export type AnyNetworkEvent = RequestEvent | ResponseEvent;

export type AnySdkEvent =
  | SdkRequestStartEvent
  | SdkRequestEndEvent
  | SdkDbQueryEvent
  | SdkCacheEvent
  | SdkCustomSpanEvent
  | SdkCustomEvent;

export type AnyProbeEvent = AnyBrowserEvent | AnyNetworkEvent | LogEvent | AnySdkEvent;

// ============================================================
// Type Guards
// ============================================================

export function isBrowserEvent(e: ProbeEvent): e is BrowserEvent {
  return e.source === 'browser';
}

export function isNetworkEvent(e: ProbeEvent): e is NetworkEvent {
  return e.source === 'network';
}

export function isLogEvent(e: ProbeEvent): e is LogEvent {
  return e.source === 'log';
}

export function isSdkEvent(e: ProbeEvent): e is SdkEvent {
  return e.source === 'sdk';
}

export function isRequestEvent(e: ProbeEvent): e is RequestEvent {
  return e.source === 'network' && (e as NetworkEvent).type === 'request';
}

export function isResponseEvent(e: ProbeEvent): e is ResponseEvent {
  return e.source === 'network' && (e as NetworkEvent).type === 'response';
}

export function isScreenshotEvent(e: ProbeEvent): e is ScreenshotEvent {
  return e.source === 'browser' && (e as BrowserEvent).type === 'screenshot';
}

export function isErrorEvent(e: ProbeEvent): e is BrowserErrorEvent {
  return e.source === 'browser' && (e as BrowserEvent).type === 'error';
}

export function isDbQueryEvent(e: ProbeEvent): e is SdkDbQueryEvent {
  return e.source === 'sdk' && (e as SdkEvent).type === 'db-query';
}
