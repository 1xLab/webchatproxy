# webchatproxy Architecture

## Scope

`webchatproxy` is a standalone HTTP gateway that controls an authenticated ChatGPT Web session through Playwright.

It has no application-layer dependency on any UI, framework, OpenAI API worker, GitHub bridge, or browser extension.

## Runtime

```text
HTTP client
    |
    v
server/lib/http-api.mjs
    |
    v
server/lib/gateway-runtime.mjs
    |
    +--> JobManager
    +--> EventJournal
    +--> Diagnostics
    |
    v
server/browser-backend.mjs
    |
    v
Playwright persistent context
    |
    v
chatgpt.com
```

## Public boundary

The HTTP API is the only supported integration boundary. External clients must not read the browser profile, runtime files, or internal classes directly.

Default address:

```text
127.0.0.1:3210
```

Primary contracts:

```text
GET    /health
GET    /ready
GET    /v1/account
GET    /v1/models
POST   /v1/jobs
GET    /v1/jobs
GET    /v1/jobs/{id}
GET    /v1/jobs/{id}/events
DELETE /v1/jobs/{id}
POST   /v1/chat/completions
```

## Browser profile

`server/browser-profile/` contains the persistent browser session. It is local runtime state, never source code, and must never be committed.

Only one active browser process may own a profile at a time.

## Jobs and concurrency

`JobManager` serializes work for the current browser/profile. Jobs are persisted under `server/runtime/jobs/` for diagnostics and restart recovery.

A restart never silently retries an in-flight message. Jobs found in transient states are marked `interrupted`.

Future horizontal scaling should use independent workers, each with its own browser profile, runtime directory, browser context, queue and health state.

## Response capture

`BrowserBackend` sends prompts through the real ChatGPT Web composer and observes both network traffic and DOM state. Network capture is preferred; DOM capture is a fallback and completion signal.

The backend also tracks live response/thinking state when observable.

## Security boundary

- bind to loopback by default;
- use `WEBCHAT_API_TOKEN` when exposing the gateway beyond a trusted local boundary;
- keep CORS disabled unless explicitly configured;
- never expose cookies, browser storage or authentication tokens through debug endpoints;
- keep `browser-profile/` and `runtime/` outside document roots and outside Git.

## Diagnostics

The proxy exposes programmatic diagnostics so operators and automated agents can inspect lifecycle, browser state, DOM state, jobs and event logs without depending on an external UI.

See `DEBUG_CONTRACT.md` and `CODE_DEBUG_ARCHITECTURE.md`.
