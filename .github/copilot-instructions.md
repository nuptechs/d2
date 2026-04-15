# Debug Probe — AI Agent Guidelines

## Overview

Universal runtime debug capture, correlation, and analysis system. Turborepo monorepo with 10 TypeScript packages. Captures events at every layer (browser, network, server, DB) and correlates them into unified timelines.

See `ARCHITECTURE.md` for full system design. See `CONTRIBUTING.md` for contribution workflow.

## Tech Stack (Firmly Decided)

| Layer | Technology |
|-------|-----------|
| Language | TypeScript 5.7+ (strict mode, `noUncheckedIndexedAccess`) |
| Monorepo | Turborepo |
| Server | Express + WebSocket (port 7070) |
| Dashboard | React 19 + Vite |
| Testing | Vitest 4.1 (coverage: v8) |
| Deploy | Docker (multi-stage, Alpine, non-root user `probe:1001`) |
| CI | Node 20 & 22 matrix |

## Package Map

```
packages/
  core/             ← Types, ports, EventBus, utilities
  sdk/              ← Node.js + browser instrumentation
  browser-agent/    ← Playwright automation
  log-collector/    ← File, Docker, stdout log capture
  network-interceptor/ ← HTTP proxy & Express middleware
  correlation-engine/  ← 3 strategies (RequestId, Temporal, UrlMatching)
  reporter/         ← HTML, JSON, Markdown report generation
  cli/              ← Command-line interface
server/             ← Express + WebSocket API
dashboard/          ← React 19 SPA
```

## Port/Adapter Pattern (6 Ports)

All external dependencies are abstracted behind ports. Adapter selection is driven by environment variables.

| Port | Adapters | Selection |
|------|----------|-----------|
| StoragePort | Memory, File, PostgreSQL | `STORAGE_TYPE` env var |
| CorrelatorPort | RequestId, Temporal, UrlMatching | Config-driven |
| ReporterPort | Html, Json, Markdown | `?format=` query param |
| BrowserAgentPort | Playwright | Default |
| LogSourcePort | File, Docker, Stdout | Config-driven |
| NetworkCapturePort | Proxy, ExpressMiddleware | Config-driven |

When adding a new external dependency, create a Port first. Do NOT import SDKs directly in business logic.

## Server Middleware Chain (order critical)

1. Metrics endpoint → 2. Health/ready → 3. CORS/Helmet/Compression → 4. Request ID/Pino logging → 5. Input sanitization/Rate limiting → 6. Auth (API key or JWT) → 7. Domain routes → 8. Error handler (LAST)

## Correlation Engine

Three strategies run in parallel:
- **RequestIdStrategy** — links events by `correlationId`/`requestId` header (most reliable)
- **TemporalStrategy** — groups within configurable time window (default 2000ms)
- **UrlMatchingStrategy** — matches navigations to network requests by URL similarity

## Coding Conventions

- **ESM only** — `import`/`export`, no `require()`
- **TypeScript strict** — no `any`, `noUncheckedIndexedAccess: true`
- **Zod at boundaries** — validate all HTTP/WebSocket/CLI input
- **Structured logging** — Pino JSON, never `console.log`
- **Immutable events** — `ProbeEvent` properties are `readonly`
- **Port/Adapter** — external deps behind abstract ports in `@probe/core`

## Build & Test

```bash
npm run build        # Turbo build all packages (respects dep order)
npm run typecheck    # tsc --noEmit across all packages
npx vitest run       # Full test suite
npx vitest run --coverage  # With v8 coverage
cd server && npm run dev   # Server :7070
cd dashboard && npm run dev  # Dashboard :3000 (proxies to :7070)
```

## Key Environment Variables

```bash
STORAGE_TYPE=memory|file|postgres   # Default: memory
DATABASE_URL=postgres://...         # For postgres adapter
PROBE_JWT_SECRET=...                # ≥32 chars
PROBE_API_KEYS=key1,key2,...        # Comma-separated, ≥16 chars each
PORT=7070
```

## WebSocket Protocol

- Auth on connection (API key in query or JWT in header)
- Subscribe: `{ type: "subscribe", sessionId }`
- Rate limit: 20 msg/s per connection, max 50 subscriptions
- Ping/pong keepalive every 30s

## Security Model

- Timing-safe API key comparison
- JWT HMAC-SHA256 verification
- Helmet CSP, HSTS, X-Frame-Options
- SSRF blocklist for private IPs in proxy
- Configurable field redaction in events
- Rate limiting: 200 reads/s, 50 writes/s per IP
