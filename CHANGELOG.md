# Changelog

All notable changes to Debug Probe are documented here.

## [Unreleased]

### R21 — Documentation (2026-03-31)
- Added `ARCHITECTURE.md` — system design, data flow, Port/Adapter pattern, security model
- Added `CONTRIBUTING.md` — development setup, testing, code conventions, CI/CD workflow
- Added `docs/API.md` — complete REST and WebSocket API reference
- Added `CHANGELOG.md` — project history from initial scaffold to current state
- Updated `README.md` with links to new documentation

### R20 — CI/CD Pipeline (2026-03-31)
- Enhanced GitHub Actions workflow with parallel jobs: typecheck, test (Node 20+22), security audit
- Added Docker image push to GHCR (`ghcr.io/nuptechs/d2`) on main branch
- Added coverage report upload as artifact (14-day retention)
- Added concurrency control to cancel superseded CI runs
- Added Dependabot config for npm, Docker, and GitHub Actions (weekly, grouped)
- Added release workflow: tag-triggered validation → Docker push → GitHub Release
- Added `typecheck` script (`tsc --noEmit`) to all 10 workspace packages
- Fixed unused `PoolStats` import in instrumented-storage.ts

### R19 — Postgres Production-Ready (2026-03-31)
- Added Prometheus pool gauges: `probe_pg_pool_total/idle/waiting/max_connections`, `probe_pg_circuit_breaker_state`
- Added advisory lock (`pg_advisory_lock`) on migrations to prevent concurrent runs
- Added pool error handler for idle client errors
- Added connection warmup (preloads `min(4, maxConnections)` on initialize)
- Added slow query detection with configurable threshold (default 500ms)
- Added periodic pool stats collection (10s interval) to InstrumentedStorage
- Enhanced `/health` endpoint with pool stats

### R18 — Dashboard Production-Ready (2026-03-31)
- Fixed health API path and TanStack Query guards
- Added Vite proxy configuration for dev/production
- Added code splitting with `React.lazy()` for all route components
- Added `tsx` dev script for server hot reload

### R17 — Test Coverage Gaps (2026-03-31)
- Added 13 new test files with 166 new tests
- Filled coverage gaps across all packages

### R16 — Observability & Performance (2026-03-31)
- Added Prometheus metrics (prom-client): HTTP, WebSocket, sessions, errors, correlators
- Added trace context propagation
- Added performance benchmarks
- 41 new tests across 5 new files

### R15 — Integration & E2E Tests (2026-03-31)
- Added full pipeline integration tests (HTTP + WS + storage + correlation)
- 92 new tests across 7 files

### R14 — Comprehensive Test Suite (2026-03-31)
- **Batch 1:** Correlation strategies + reporter adapter tests (+161 tests)
- **Batch 2+3:** SDK interceptors (Postgres, MySQL, MongoDB, Redis, XHR, Fetch, console, error boundary) + log-collector + server middleware tests (+791 tests, 13 files)
- **Batch 4:** Core utils, correlation engine, network filter, storage, request tracer tests (+125 tests, 7 files)

### R13 — Deep Hardening (2026-03-31)
- Data integrity guards
- Broadcast isolation (per-session event delivery)
- JWT validation hardening
- Race condition fixes

### R12 — Hardened Code Test Coverage (2026-03-31)
- 167 new tests across 6 new files covering hardened code paths

### R11 — Security Round 6 (2026-03-31)
- SSRF CONNECT bypass prevention
- Log redaction for sensitive data
- Production auth guards (reject `PROBE_AUTH_DISABLED` in production)
- Expanded IP blocklist

### R10 — Security Round 5 (2026-03-31)
- SSRF protection in proxy adapter
- Proxy hardening (private IP blocking)
- Console/log output caps
- Dashboard auth integration

### R9 — Deep Hardening (2026-03-31)
- Browser-agent resource cleanup
- Correlator memory caps
- WebSocket stability improvements
- Reporter output sanitization

### R8 — Security Round 4 (2026-03-31)
- Timing-safe WebSocket authentication
- Memory caps on session/event storage
- 4 new test suites

### R7 — WebSocket Auth (2026-03-31)
- WebSocket connection authentication (API key + JWT)
- 11 security hardening fixes

### R6 — Test Coverage + Hardening (2026-03-31)
- 48 new tests
- Additional security hardening

## Pre-R6 (2026-03-29 — 2026-03-31)

### Hardening Rounds 1–5
- **Round 5:** Memory leak fixes, regex state management, tunnel DoS prevention, auth improvements
- **Round 4:** Sensitive data redaction, reporter XSS/injection prevention, CLI hardening
- **Round 3:** Path traversal prevention, CORS hardening, SSL support, auth guard, timing-safe key comparison
- **Round 2:** Health checks, memory caps, WebSocket limits, rate limiter split (read/write), tests
- **Round 1:** Circuit breaker, retry logic, write locks, Zod validation, CSP headers, audit logging

### Security + Tests (2026-03-30)
- Helmet security headers
- Zod environment validation
- WebSocket origin check
- Graceful shutdown (30s drain)
- Database connection timeouts
- Credential cleanup
- 61 new tests (157 total)

### Production-Grade Hardening (2026-03-30)
- Centralized error handling
- Structured logging (Pino)
- Scalability fixes

### PostgreSQL Persistence (2026-03-30)
- PostgreSQL storage adapter with migrations
- Full data pipeline (ingest → store → correlate → query)

### Dashboard + Docker + CI (2026-03-30)
- React 19 dashboard with TanStack Query
- SDK demo application
- Multi-stage Dockerfile
- Initial GitHub Actions CI pipeline

### Enterprise Features (2026-03-30)
- API key + JWT authentication
- File persistence adapter
- Backpressure handling
- SDK interceptors (DB, network, console)
- 96 tests

### Initial Scaffold (2026-03-29)
- Monorepo structure with 8 packages
- Core types, ports, EventBus
- Browser agent (Playwright)
- Log collector (file, Docker, stdout)
- Network interceptor (proxy, middleware)
- Correlation engine (3 strategies)
- Reporter (HTML, JSON, Markdown)
- CLI (capture, watch, report, replay)
