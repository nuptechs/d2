// ============================================================
// Fetch Interceptor — Monkey-patches globalThis.fetch
// Injects correlation headers and emits request events
// ============================================================

import type { SdkEvent } from '@probe/core';

type EventHandler = (event: Omit<SdkEvent, 'id' | 'sessionId' | 'timestamp'>) => void;

export interface FetchInterceptorConfig {
  correlationHeader: string;
  correlationId?: string;
  onEvent: EventHandler;
}

/**
 * Install a fetch interceptor that:
 * - Injects correlation ID header into every outgoing request
 * - Emits request-start and request-end events
 * - Tracks request duration
 *
 * Returns a restore function that puts the original fetch back.
 */
export function installFetchInterceptor(config: FetchInterceptorConfig): () => void {
  const originalFetch = globalThis.fetch;

  if (!originalFetch) {
    // No fetch available (e.g. old env) — no-op
    return () => {};
  }

  let requestCounter = 0;

  globalThis.fetch = async function probeFetchInterceptor(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const requestId = `browser-req-${++requestCounter}-${Date.now().toString(36)}`;
    const startTime = performance.now();

    // Resolve URL and method from the various input forms
    const { url, method } = resolveRequestInfo(input, init);

    // Build headers, injecting correlation ID
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (config.correlationId && !headers.has(config.correlationHeader)) {
      headers.set(config.correlationHeader, config.correlationId);
    }

    // Emit request-start
    config.onEvent({
      source: 'sdk',
      type: 'request-start' as const,
      requestId,
      method,
      url,
      headers: headersToRecord(headers),
    } as Omit<SdkEvent, 'id' | 'sessionId' | 'timestamp'>);

    // Build the modified init with injected headers
    const modifiedInit: RequestInit = {
      ...init,
      headers,
    };

    try {
      // If input was a Request, we need to pass the URL + modified init
      const response = input instanceof Request
        ? await originalFetch(input.url, { ...requestInitFromRequest(input), ...modifiedInit })
        : await originalFetch(input, modifiedInit);

      const duration = performance.now() - startTime;

      // Emit request-end
      config.onEvent({
        source: 'sdk',
        type: 'request-end' as const,
        requestId,
        statusCode: response.status,
        duration: Math.round(duration * 100) / 100,
      } as Omit<SdkEvent, 'id' | 'sessionId' | 'timestamp'>);

      return response;
    } catch (err) {
      const duration = performance.now() - startTime;

      // Emit request-end with error
      config.onEvent({
        source: 'sdk',
        type: 'request-end' as const,
        requestId,
        statusCode: 0,
        duration: Math.round(duration * 100) / 100,
        error: err instanceof Error ? err.message : String(err),
      } as Omit<SdkEvent, 'id' | 'sessionId' | 'timestamp'>);

      throw err;
    }
  };

  // Return restore function
  return () => {
    globalThis.fetch = originalFetch;
  };
}

// ---- Internal helpers ----

function resolveRequestInfo(
  input: RequestInfo | URL,
  init?: RequestInit,
): { url: string; method: string } {
  if (input instanceof Request) {
    return {
      url: input.url,
      method: init?.method ?? input.method,
    };
  }
  if (input instanceof URL) {
    return {
      url: input.href,
      method: init?.method ?? 'GET',
    };
  }
  // String URL
  return {
    url: input,
    method: init?.method ?? 'GET',
  };
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function requestInitFromRequest(req: Request): RequestInit {
  return {
    method: req.method,
    headers: req.headers,
    body: req.body,
    mode: req.mode,
    credentials: req.credentials,
    cache: req.cache,
    redirect: req.redirect,
    referrer: req.referrer,
    referrerPolicy: req.referrerPolicy,
    integrity: req.integrity,
    signal: req.signal,
  };
}
