# Agent Contract

Canonical repository: `1xLab/webchatproxy`
Canonical branch: `main`

## Product scope

`webchatproxy` is an independent Node.js/Playwright product that exposes an HTTP API over an authenticated ChatGPT Web browser session.

It must not depend on Laravel, PHP applications, `webagent`, `ws_com_ia`, OpenAI API workers, GitHub job bridges, or browser extensions.

## Canonical runtime

```text
server/bootstrap.mjs
server/standalone.mjs
server/browser-backend.mjs
server/lib/
```

Normal lifecycle:

```bash
cd server
./start.sh start
./start.sh status
./start.sh doctor
./start.sh doctor-live
```

Default bind address:

```text
127.0.0.1:3210
```

## Architectural boundary

Every external consumer uses the HTTP API.

```text
HTTP clients
    |
    v
Gateway HTTP API
    |
    v
JobManager
    |
    v
BrowserBackend
    |
    v
Playwright
    |
    v
chatgpt.com
```

External consumers must never read or import `BrowserBackend`, `runtime/`, or `browser-profile/` directly.

## Runtime state

The following directories are private local state and must never be committed:

```text
server/browser-profile/
server/runtime/
```

The core must never execute from a public document root.

## Debug contract

Before asking for human intervention, use the programmatic diagnostics:

1. `./start.sh status`
2. `./start.sh doctor`
3. `GET /v1/debug/runtime`
4. `GET /v1/debug/events`
5. `GET /v1/debug/dom`
6. `POST /v1/debug/bundle` when persistent evidence is useful
7. `./start.sh doctor-live`

The normal human-only exception is interactive ChatGPT authentication after an explicit `auth_required` diagnosis.

Never kill an unknown process to free a port. Select another `WEBCHAT_PORT` instead.

## Development contract

For changes to the product:

```text
branch -> commits -> pull request -> CI -> review -> merge
```

Run at minimum:

```bash
cd server
npm ci
npm run check
npm test
npm run doctor:contract
```

The proxy repository must remain independently buildable and testable without any other application repository.
