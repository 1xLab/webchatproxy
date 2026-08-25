# Kimi provider

Pinned web-session provider based on `izaart95-jpg/KimiFreeAPI`.

## Runtime

- HTTP: `127.0.0.1:3230`
- Auth token: `runtime/kimi/access_token`
- Local API key: `runtime/kimi/.api-key`
- Vendor checkout/build: `.vendor/kimi-free-api`
- No browser or CDP is required during normal runtime.

## Install

```bash
providers/kimi/engine/install.sh
```

The installer fetches the exact commit from `UPSTREAM.lock`, applies reviewed source patches, runs `gofmt`, `go vet`, and builds the binary.

## Import login token

From a logged-in `https://www.kimi.com` browser session, copy the `access_token` value from localStorage, then run:

```bash
providers/kimi/engine/import-token.sh
```

The token is written with mode `0600` under `runtime/kimi/` and is never committed.

## Start

```bash
providers/kimi/engine/start.sh
```

The start script fails closed if the pinned engine is absent, the token is absent, or the local API key is absent/empty. The API binds to loopback by default.

## API

- `GET /v1/models`
- `POST /v1/chat/completions`

Both require `Authorization: Bearer <runtime/kimi/.api-key>`.

## Capability boundary

Kimi exposes models and chat only. It does not expose ChatGPT-style projects, project files, project-scoped conversations, or a history API through this provider.

The upstream does expose session controls outside the OpenAI facade:

- `GET /history` reports/toggles the stateful session mode.
- `POST /history` enables or disables stateful session mode.
- `POST /new` starts a fresh session.

These are session controls, not a project list or queryable conversation-history API. Live validation of `/v1/projects` and `/v1/conversations` returns `404`; the provider's upstream session state must not be presented as a project API.

## Upstream audit notes

The upstream uses global conversation state guarded by a mutex. Treat one Kimi provider process as one serialized account/session domain; do not assume independent per-client conversation state. The webchatproxy provider is isolated from ChatGPT and DeepSeek at process/runtime level.
