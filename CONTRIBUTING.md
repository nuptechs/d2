# Contributing to Debug Probe

## Prerequisites

- **Node.js** ≥ 20 (LTS recommended)
- **npm** ≥ 10
- **Docker** (optional, for PostgreSQL and container testing)
- **Git**

## Getting Started

```bash
# Clone the repository
git clone https://github.com/nuptechs/d2.git debug-probe
cd debug-probe

# Install all dependencies (workspaces resolved automatically)
npm install

# Build all packages (respects dependency order via Turborepo)
npm run build

# Run all tests
npx vitest run

# Start the server in development mode (with hot reload)
cd server && npm run dev
# → http://localhost:7070

# Start the dashboard in development mode (separate terminal)
cd dashboard && npm run dev
# → http://localhost:3000 (proxies API calls to :7070)
```

## Project Structure

```
debug-probe/
├── packages/
│   ├── core/                 # Types, ports, EventBus, utilities
│   ├── browser-agent/        # Playwright browser automation
│   ├── log-collector/        # File, Docker, stdout log adapters
│   ├── network-interceptor/  # HTTP proxy & Express middleware
│   ├── correlation-engine/   # Event correlation (3 strategies)
│   ├── reporter/             # HTML, JSON, Markdown reports
│   ├── sdk/                  # Node.js & browser instrumentation
│   └── cli/                  # Command-line interface
├── server/                   # Express + WebSocket API server
├── dashboard/                # React 19 web UI
├── examples/
│   └── express-app/          # Instrumented demo application
├── .github/
│   ├── workflows/ci.yml      # CI pipeline
│   ├── workflows/release.yml # Tag-based releases
│   └── dependabot.yml        # Automated dependency updates
├── turbo.json                # Turborepo task configuration
├── tsconfig.base.json        # Shared TypeScript config
├── vitest.config.ts          # Test configuration
├── Dockerfile                # Multi-stage production build
└── docker-compose.yml        # Development stack
```

## Development Workflow

### Branch Strategy

- **`main`** — primary branch, all work happens here
- Feature branches — optional for larger changes, merge via PR

### Common Commands

```bash
# Build everything
npm run build

# Type-check without building (fast feedback)
npm run typecheck

# Run all 1387 tests
npx vitest run

# Run tests in watch mode
npx vitest

# Run tests with coverage
npx vitest run --coverage

# Build + run a specific package
cd packages/core && npm run build

# Clean all build artifacts
npm run clean
```

### Adding a New Package

1. Create `packages/<name>/` with `package.json`, `tsconfig.json`, and `src/`
2. Name it `@probe/<name>` and set `"type": "module"`
3. Add scripts: `build`, `dev`, `typecheck`, `clean`, `test`
4. Reference `tsconfig.base.json` via `extends`
5. Add the package as a dependency in consumers: `"@probe/<name>": "*"`
6. Run `npm install` from the root to link workspaces

### Code Conventions

- **TypeScript strict mode** — no `any`, no unchecked index access
- **ESM only** — use `import`/`export`, no `require()`
- **Port/Adapter pattern** — external dependencies behind abstract ports (see [ARCHITECTURE.md](ARCHITECTURE.md))
- **Immutable events** — all `ProbeEvent` properties are `readonly`
- **Zod at boundaries** — validate all external input (HTTP, WebSocket, CLI args)
- **Structured logging** — use Pino logger, never `console.log` in server code
- **Error handling** — use `asyncHandler()` wrapper, typed error responses

## Testing

### Test Structure

Tests live alongside the code they test:

```
packages/core/__tests__/
packages/sdk/__tests__/
server/__tests__/
  ├── integration/     # Full pipeline tests (HTTP + WS + storage)
  ├── middleware/       # Auth, rate limiting, error handling
  ├── ws/              # WebSocket protocol tests
  ├── observability/   # Metrics and health endpoint tests
  └── performance/     # Benchmark tests
```

### Running Tests

```bash
# All tests (recommended — uses root vitest.config.ts)
npx vitest run

# Watch mode (re-runs on file change)
npx vitest

# Single file
npx vitest run server/__tests__/middleware/auth.test.ts

# With coverage report
npx vitest run --coverage

# Filter by test name
npx vitest run -t "should reject expired JWT"
```

### Writing Tests

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('MyFeature', () => {
  it('should do the expected thing', () => {
    const result = myFunction(input);
    expect(result).toBe(expected);
  });
});
```

**Guidelines:**
- Test behavior, not implementation
- Use `vi.fn()` for mocks, `vi.useFakeTimers()` for time-dependent tests
- Clean up resources in `afterEach` (close servers, clear intervals)
- Integration tests can create real HTTP servers via Supertest

## Docker

### Development

```bash
# Start PostgreSQL + server in dev mode
docker compose --profile dev up

# Or just PostgreSQL
docker compose up db
```

### Production Build

```bash
# Build the image
docker build -t debug-probe .

# Run with in-memory storage
docker run -p 7070:7070 -e PROBE_AUTH_DISABLED=1 debug-probe

# Run with PostgreSQL
docker run -p 7070:7070 \
  -e DATABASE_URL=postgres://user:pass@host:5432/debug_probe \
  -e STORAGE_TYPE=postgres \
  -e PROBE_API_KEYS=your-api-key-here \
  debug-probe
```

### Health Check

The container includes a built-in health check:

```bash
curl http://localhost:7070/health
# {"status":"ok","storage":"connected","uptime":123.4,...}

curl http://localhost:7070/ready
# {"status":"ready"}
```

## Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7070` | Server listen port |
| `HOST` | `0.0.0.0` | Server listen address |
| `NODE_ENV` | `development` | `development` / `production` / `test` |
| `LOG_LEVEL` | `debug` | Pino log level |
| `DATABASE_URL` | — | PostgreSQL connection string (optional) |
| `STORAGE_TYPE` | `memory` | `memory` / `file` / `postgres` |
| `STORAGE_PATH` | `.probe-data` | File storage directory |
| `PROBE_API_KEYS` | — | Comma-separated API keys (≥16 chars each) |
| `PROBE_JWT_SECRET` | — | JWT signing secret (≥32 chars) |
| `PROBE_AUTH_DISABLED` | — | Set to `1` to disable auth (dev only) |
| `CORS_ORIGINS` | — | Comma-separated allowed origins |

## CI/CD

Every push to `main` and every pull request triggers the CI pipeline:

1. **Typecheck** — `tsc --noEmit` across all packages
2. **Test** — Vitest with Node.js 20 and 22
3. **Security Audit** — `npm audit --audit-level=high`
4. **Docker** — Build image, verify `/health`, push to GHCR (main only)

### Creating a Release

```bash
# Tag the current commit
git tag v1.0.0

# Push the tag — triggers release workflow
git push origin v1.0.0
```

The release workflow validates (build + typecheck + test), pushes a versioned Docker image to GHCR, and creates a GitHub Release with auto-generated notes.

## Commit Messages

Use descriptive commit messages. The project follows this convention:

```
feat: description of new feature
fix: description of bug fix
fix(security): security-related fix
test: new or modified tests
docs: documentation changes
refactor: code restructuring without behavior change
```
