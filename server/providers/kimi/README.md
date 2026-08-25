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

## Facade and native capabilities

The WebChatProxy facade currently exposes models and chat only. The authenticated
Kimi Web runtime natively exposes projects, project chats and message history
through Connect/JSON RPC under `/apiv2`.

The upstream does expose session controls outside the OpenAI facade:

- `GET /history` reports/toggles the stateful session mode.
- `POST /history` enables or disables stateful session mode.
- `POST /new` starts a fresh session.

The Kimi Web project service is:

```text
POST /apiv2/kimi.gateway.project.v1.ProjectService/ListProjects
POST /apiv2/kimi.gateway.project.v1.ProjectService/GetProject
POST /apiv2/kimi.gateway.project.v1.ProjectService/CreateProject
POST /apiv2/kimi.gateway.project.v1.ProjectService/UpdateProject
POST /apiv2/kimi.gateway.project.v1.ProjectService/DeleteProject
POST /apiv2/kimi.gateway.project.v1.ProjectService/ListProjectFiles
POST /apiv2/kimi.gateway.project.v1.ProjectService/SetChatProject
```

Project conversations and history use:

```text
POST /apiv2/kimi.gateway.chat.v1.ChatService/ListChats
POST /apiv2/kimi.gateway.chat.v1.ChatService/GetChat
POST /apiv2/kimi.gateway.chat.v1.ChatService/ListMessages
POST /apiv2/kimi.gateway.chat.v1.ChatService/ResumeChat
POST /apiv2/kimi.gateway.chat.v1.ChatService/Chat
```

`ListChats` accepts `project_id`; `GetChat` returns `projectId`; and
`ListMessages` returns the persisted message tree. These endpoints use the
existing Kimi Web `access_token`/`refresh_token`, not a Moonshot API key.

Live validation of `/v1/projects` and `/v1/conversations` returning `404`
describes the facade only, not the native Kimi Web capability.

## Upstream audit notes

The upstream uses global conversation state guarded by a mutex. Treat one Kimi provider process as one serialized account/session domain; do not assume independent per-client conversation state. The webchatproxy provider is isolated from ChatGPT and DeepSeek at process/runtime level.
