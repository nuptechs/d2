const BASE_URL = '/api';

function getApiKey(): string {
  // Prefer sessionStorage (more secure, cleared on tab close)
  const sessionKey = sessionStorage.getItem('probe-api-key');
  if (sessionKey) return sessionKey;
  // Fall back to apiKey stored in settings (for Settings page compat)
  try {
    const settings = JSON.parse(localStorage.getItem('probe-settings') ?? '{}');
    if (settings.apiKey) {
      // Migrate to sessionStorage for this tab session
      sessionStorage.setItem('probe-api-key', settings.apiKey);
      return settings.apiKey as string;
    }
  } catch { /* ignore parse errors */ }
  return '';
}

interface RequestOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined>;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { params, ...fetchOptions } = options;
  let url = `${BASE_URL}${path}`;

  if (params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) searchParams.set(key, String(value));
    }
    const qs = searchParams.toString();
    if (qs) url += `?${qs}`;
  }

  const apiKey = getApiKey();
  const res = await fetch(url, {
    ...fetchOptions,
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      ...fetchOptions.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (body as Record<string, string>).error || res.statusText);
  }

  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// --- Sessions ---

export interface Session {
  id: string;
  status: 'idle' | 'capturing' | 'paused' | 'completed' | 'error';
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  sources: string[];
}

export interface SessionsResponse {
  sessions: Session[];
  total: number;
}

export const api = {
  sessions: {
    list: () => request<SessionsResponse>('/sessions'),
    get: (id: string) => request<Session>(`/sessions/${id}`),
    create: (config?: Record<string, unknown>) =>
      request<Session>('/sessions', { method: 'POST', body: JSON.stringify({ config }) }),
    delete: (id: string) => request<void>(`/sessions/${id}`, { method: 'DELETE' }),
    updateStatus: (id: string, status: string) =>
      request<Session>(`/sessions/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
  },
  events: {
    list: (sessionId: string, params?: { source?: string; type?: string; limit?: number; offset?: number }) =>
      request<{ events: ProbeEvent[]; total: number }>(`/sessions/${sessionId}/events`, { params }),
    ingest: (sessionId: string, events: ProbeEvent[]) =>
      request<{ received: number }>(`/sessions/${sessionId}/events`, {
        method: 'POST',
        body: JSON.stringify({ events }),
      }),
    timeline: (sessionId: string) =>
      request<{ timeline: TimelineEntry[] }>(`/sessions/${sessionId}/timeline`),
  },
  reports: {
    generate: (sessionId: string, format: 'html' | 'json' | 'markdown' = 'json') =>
      request<unknown>(`/sessions/${sessionId}/report`, { params: { format } }),
  },
  health: {
    check: () => request<{ status: string; uptime: number }>('/health'),
  },
};

// --- Event types ---

export interface ProbeEvent {
  id: string;
  type: string;
  source: 'browser' | 'network' | 'log' | 'sdk';
  sessionId: string;
  timestamp: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  data: Record<string, unknown>;
}

export interface TimelineEntry {
  timestamp: string;
  event: ProbeEvent;
  correlationGroup?: string;
}

export interface CorrelationGroup {
  id: string;
  correlationId: string;
  events: ProbeEvent[];
  summary: {
    duration: number;
    eventCount: number;
    sources: string[];
    hasErrors: boolean;
  };
}
