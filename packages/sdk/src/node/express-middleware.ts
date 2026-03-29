// ============================================================
// Express Middleware — HTTP request/response instrumentation
// Works WITHOUT Express installed (uses compatible signatures)
// ============================================================

import type { SdkConfig, SdkRequestStartEvent, SdkRequestEndEvent } from '@probe/core';
import {
  generateRequestId,
  generateCorrelationId,
  nowMs,
  redactHeaders,
} from '@probe/core';
import type { ProbeContext } from './context.js';
import { runWithContext } from './context.js';
import { SdkEventCollector } from './event-collector.js';

// Express-compatible types — NO dependency on @types/express
interface IncomingMessage {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  probeContext?: ProbeContext;
}

interface ServerResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  on(event: string, listener: () => void): void;
}

type NextFunction = (err?: unknown) => void;
type ExpressMiddleware = (req: IncomingMessage, res: ServerResponse, next: NextFunction) => void;

/** Default collector instance used when none is provided */
let defaultCollector: SdkEventCollector | undefined;

/** Get or create the default SDK event collector */
export function getDefaultCollector(): SdkEventCollector {
  if (!defaultCollector) {
    defaultCollector = new SdkEventCollector();
  }
  return defaultCollector;
}

export interface ProbeMiddlewareOptions {
  config: SdkConfig;
  collector?: SdkEventCollector;
  sessionId?: string;
}

/**
 * Create an Express-compatible middleware that instruments HTTP requests.
 *
 * - Extracts or generates correlation IDs
 * - Emits request-start and request-end events
 * - Propagates context via AsyncLocalStorage
 */
export function createProbeMiddleware(
  configOrOptions: SdkConfig | ProbeMiddlewareOptions,
): ExpressMiddleware {
  const options: ProbeMiddlewareOptions = 'config' in configOrOptions && 'collector' in configOrOptions
    ? configOrOptions as ProbeMiddlewareOptions
    : { config: configOrOptions as SdkConfig };

  const { config } = options;
  const collector = options.collector ?? getDefaultCollector();

  if (options.sessionId) {
    collector.setSessionId(options.sessionId);
  }

  return function probeMiddleware(req: IncomingMessage, res: ServerResponse, next: NextFunction): void {
    if (!config.enabled) {
      next();
      return;
    }

    // Extract or generate correlation ID
    const incomingCorrelation = req.headers[config.correlationHeader];
    const correlationId = (typeof incomingCorrelation === 'string' && incomingCorrelation)
      ? incomingCorrelation
      : generateCorrelationId();

    // Generate request ID
    const requestId = generateRequestId();
    const startTime = nowMs();

    // Build probe context
    const context: ProbeContext = {
      correlationId,
      requestId,
      sessionId: collector['sessionId'] ?? '',
    };

    // Attach to request object for downstream access
    req.probeContext = context;

    // Propagate correlation ID back in response headers
    res.setHeader(config.correlationHeader, correlationId);
    res.setHeader('x-probe-request-id', requestId);

    // Flatten headers for event emission
    const flatHeaders: Record<string, string> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (typeof val === 'string') {
        flatHeaders[key] = val;
      } else if (Array.isArray(val)) {
        flatHeaders[key] = val.join(', ');
      }
    }

    // Emit request-start event
    collector.emit({
      type: 'request-start' as const,
      requestId,
      correlationId,
      method: req.method ?? 'UNKNOWN',
      url: req.url ?? '/',
      headers: redactHeaders(flatHeaders, config.sensitiveHeaders),
      remoteAddress: req.socket?.remoteAddress,
    } satisfies Omit<SdkRequestStartEvent, 'id' | 'sessionId' | 'timestamp' | 'source'>);

    // On response finish, emit request-end event
    res.on('finish', () => {
      const duration = nowMs() - startTime;

      collector.emit({
        type: 'request-end' as const,
        requestId,
        correlationId,
        statusCode: res.statusCode,
        duration,
        error: res.statusCode >= 500 ? `HTTP ${res.statusCode}` : undefined,
      } satisfies Omit<SdkRequestEndEvent, 'id' | 'sessionId' | 'timestamp' | 'source'>);
    });

    // Run the rest of the middleware chain within the async context
    runWithContext(context, () => {
      next();
    });
  };
}

/**
 * Get the probe context attached to a request object.
 * Returns undefined if the middleware hasn't run for this request.
 */
export function getProbeContext(req: IncomingMessage): ProbeContext | undefined {
  return req.probeContext;
}
