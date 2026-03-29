# Debug Probe

> Universal runtime debug capture, correlation, and analysis for any application stack.

**Debug Probe** instruments your application at every layer — browser, network, server, database — and correlates events into a unified timeline. When a bug happens, you get a complete picture: what the user clicked, what HTTP requests fired, what the server logged, what DB queries ran, and how they all connect.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          Debug Probe                            │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ Browser  │  │   Log    │  │ Network  │  │   SDK    │       │
│  │  Agent   │  │Collector │  │Intercept │  │ (Node/  │       │
│  │(Playwrt) │  │(File/    │  │(Proxy/   │  │ Browser)│       │
│  │          │  │ Docker)  │  │ Midware) │  │         │       │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬────┘       │
│       │              │              │              │             │
│       ▼              ▼              ▼              ▼             │
│  ┌─────────────────────────────────────────────────────┐       │
│  │              EventBus (pub/sub)                     │       │
│  └──────────────────────┬──────────────────────────────┘       │
│                         ▼                                       │
│  ┌─────────────────────────────────────────────────────┐       │
│  │        Correlation Engine (3 strategies)            │       │
│  │   request-id  ·  temporal  ·  url-matching          │       │
│  └──────────────────────┬──────────────────────────────┘       │
│                         ▼                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                     │
│  │  HTML    │  │   JSON   │  │ Markdown │   ← Reporter        │
│  │ Report   │  │  Export  │  │  Report  │                     │
│  └──────────┘  └──────────┘  └──────────┘                     │
└─────────────────────────────────────────────────────────────────┘
```

## Monorepo Structure

| Package | Purpose |
|---------|---------|
| `@probe/core` | Types, ports (interfaces), EventBus, utilities |
| `@probe/browser-agent` | Playwright-based browser automation & capture |
| `@probe/log-collector` | File tail, Docker logs, stdout/stderr adapters |
| `@probe/network-interceptor` | HTTP proxy & Express middleware capture |
| `@probe/correlation-engine` | Event correlation with 3 strategies + timeline |
| `@probe/reporter` | HTML, JSON, Markdown report generation |
| `@probe/sdk` | Instrumentation for Node.js (Express) & browsers |
| `@probe/cli` | Command-line interface: capture, watch, report, replay |
| `@probe/server` | Express + WebSocket API server |

## Quick Start

### Prerequisites

- Node.js ≥ 20
- npm ≥ 10

### Install

```bash
git clone <repo-url> debug-probe
cd debug-probe
npm install
npm run build
```

### Capture a Debug Session

```bash
# Full capture: browser + network + logs
npx probe capture http://localhost:3000 \
  --log-file ./logs/app.log \
  --format html \
  --output ./debug-output

# Watch logs in real-time
npx probe watch --log-file ./logs/app.log --level warn

# Generate report from saved session
npx probe report ./debug-output/session.json --format markdown
```

### Instrument Your Node.js Server (SDK)

```typescript
import { createProbeMiddleware } from '@probe/sdk/node';

const app = express();

// Add probe middleware — captures requests, responses, timing
app.use(createProbeMiddleware({
  enabled: true,
  captureDbQueries: true,
  captureCache: true,
  captureCustomSpans: true,
  correlationHeader: 'x-probe-correlation-id',
}));
```

### Instrument Your Frontend (Browser SDK)

```typescript
import { installFetchInterceptor } from '@probe/sdk/browser';
import { installErrorBoundary } from '@probe/sdk/browser';

// Capture all fetch requests + inject correlation headers
const restoreFetch = installFetchInterceptor({
  correlationHeader: 'x-probe-correlation-id',
  onEvent: (event) => sendToProbeServer(event),
});

// Capture uncaught errors and unhandled rejections
const restoreErrors = installErrorBoundary(
  (event) => sendToProbeServer(event)
);

// Later: cleanup
restoreFetch();
restoreErrors();
```

### Start the Server (API + WebSocket)

```bash
cd server
npm start
# Server runs on http://localhost:7070
# WebSocket on ws://localhost:7070
```

**REST API:**
- `POST /api/sessions` — Create session
- `GET /api/sessions` — List sessions
- `POST /api/sessions/:id/events` — Ingest events (batch ≤ 1000)
- `GET /api/sessions/:id/timeline` — Get correlated timeline
- `GET /api/sessions/:id/report?format=html` — Generate report

**WebSocket Protocol:**
```json
{ "type": "subscribe", "sessionId": "sess-..." }
→ { "type": "event", "sessionId": "...", "event": {...} }
→ { "type": "group", "sessionId": "...", "group": {...} }
```

## Configuration

Create a `.proberc.json` in your project root:

```json
{
  "projectName": "my-app",
  "outputDir": ".probe-data",
  "session": {
    "browser": {
      "enabled": true,
      "targetUrl": "http://localhost:3000",
      "screenshotOnAction": true,
      "captureConsole": true,
      "headless": false,
      "viewport": { "width": 1280, "height": 720 }
    },
    "network": {
      "enabled": true,
      "mode": "proxy",
      "captureBody": true,
      "excludeExtensions": [".css", ".js", ".png", ".jpg", ".svg", ".woff2"]
    },
    "logs": [
      {
        "enabled": true,
        "source": { "type": "file", "name": "backend", "path": "./logs/app.log" }
      },
      {
        "enabled": true,
        "source": { "type": "docker", "name": "postgres", "containerId": "abc123" }
      }
    ],
    "correlation": {
      "strategies": ["request-id", "temporal", "url-matching"],
      "temporalWindowMs": 2000,
      "correlationHeader": "x-probe-correlation-id",
      "groupTimeoutMs": 30000
    }
  }
}
```

Environment variable overrides:
- `PROBE_TARGET_URL` — Browser target URL
- `PROBE_PROXY_PORT` — Network proxy port
- `PROBE_OUTPUT_DIR` — Output directory

## Design Principles

### Port/Adapter Pattern

Every external dependency is behind an abstract port class. Adapters implement the ports. This means:

- **Swap Playwright for Puppeteer** → write a new `BrowserAgentPort` adapter
- **Use S3 instead of local files** → write a new `StoragePort` adapter
- **Add a Datadog reporter** → write a new `ReporterPort` adapter
- **Switch from pg to mysql** → write a new `LogSourcePort` adapter for MySQL slow query log

```
Port (abstract class)     →  Adapter (concrete implementation)
─────────────────────────────────────────────────────────────
BrowserAgentPort          →  PlaywrightBrowserAdapter
LogSourcePort             →  FileLogAdapter, DockerLogAdapter, StdoutLogAdapter
NetworkCapturePort        →  ProxyAdapter, MiddlewareAdapter
CorrelatorPort            →  EventCorrelator
StoragePort               →  (FileStorage — planned)
ReporterPort              →  HtmlReporter, JsonReporter, MarkdownReporter
```

### EventBus — Decoupled Communication

Components never talk to each other directly. The EventBus provides:
- Type-based subscriptions (`bus.on('browser:click', handler)`)
- Source-level cascading (`bus.on('browser', handler)` catches all browser events)
- Wildcard subscriptions (`bus.onAny(handler)`)

### Immutable Events

All event types use `readonly` properties. Events are created once and never modified. This ensures:
- Safe concurrent reads
- Reliable timeline reconstruction
- No accidental mutation in correlation

### Correlation Strategies

1. **request-id** — Links events sharing the same correlation ID or request ID
2. **temporal** — Groups events within a time window after a trigger (e.g., click → requests within 2s)
3. **url-matching** — Matches browser navigations to network requests by URL

## Development

```bash
# Build all packages
npm run build

# Watch mode (development)
npm run dev

# Run tests
npm test

# Clean all build artifacts
npm run clean
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript 5.7+ (strict mode) |
| Runtime | Node.js 20+ |
| Module System | ESM (ES2022) |
| Monorepo | Turborepo |
| Browser Automation | Playwright |
| HTTP Proxy | Node.js native `http` |
| Server | Express 4 + ws 8 |
| CLI | Commander 12 + Chalk 5 + Ora 8 |

## License

MIT
