# Code Debug Architecture

## Core rule

The canonical product is the HTTP gateway. Browser automation, queueing and diagnostics are internal implementation details.

```text
HTTP clients
    |
    v
Gateway HTTP API :3210
    |
    v
GatewayRuntime
    |
    +--> JobManager
    +--> EventJournal
    +--> Diagnostics
    |
    v
BrowserBackend
    |
    v
Playwright
    |
    v
ChatGPT Web
```

Never integrate external clients directly with `BrowserBackend`, `browser-profile/` or `runtime/jobs/`.

## Layers

### Composition root

`server/standalone.mjs`

Creates the runtime, HTTP server and lifecycle hooks.

### Runtime

`server/lib/gateway-runtime.mjs`

Composes BrowserBackend, JobManager, EventJournal and diagnostics. It does not know any external application framework.

### HTTP API

`server/lib/http-api.mjs`

Owns Bearer authentication, CORS, JSON parsing/serialization, routing, HTTP status codes and the OpenAI-compatible chat endpoint. It contains no Playwright logic.

### Browser core

`server/browser-backend.mjs`

Owns the ChatGPT Web browser session, navigation, prompt submission, response capture, progress and completion detection.

### Jobs

`server/lib/job-manager.mjs`

Owns queueing, idempotency, persistence, cancellation and terminal job state.

## Local state boundary

```text
server/browser-profile/   persistent ChatGPT Web session
server/runtime/jobs/      persisted jobs
server/runtime/logs/      structured/process logs
server/runtime/debug/     diagnostic evidence
```

These paths are operational state, not source code and not a public API.

## Programmatic diagnostics

Recommended order:

```bash
cd server
./start.sh status
./start.sh doctor
curl -sS -H "Authorization: Bearer $WEBCHAT_API_TOKEN" http://127.0.0.1:3210/v1/debug/runtime
curl -sS -H "Authorization: Bearer $WEBCHAT_API_TOKEN" http://127.0.0.1:3210/v1/debug/events
./start.sh doctor-live
```

`/v1/debug/runtime` provides a single execution snapshot including active job, request id, browser/page state, network completion, captured response/thinking lengths, URL, assistant message count, composer and Stop/Done indicators.

## Test contract

CI for this repository tests only the proxy product:

- Node syntax;
- unit/regression tests;
- JobManager;
- HTTP/auth contract;
- doctor contract;
- `/v1/debug/runtime`;
- shell syntax;
- filesystem safety boundary.

No external UI or application repository is required for CI.

## Human intervention

The proxy must diagnose itself by API/code before requesting manual action. The normal exception is interactive ChatGPT authentication when the persisted profile is explicitly classified as `auth_required`.
