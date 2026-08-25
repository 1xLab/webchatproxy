# Kimi provider

Pinned Kimi Web-session provider based on `izaart95-jpg/KimiFreeAPI` plus reviewed native project/conversation extensions.

## Runtime

- Internal provider runtime: `127.0.0.1:3330`
- Public provider facade: `127.0.0.1:3230`
- Auth tokens: `runtime/kimi/access_token` and `runtime/kimi/refresh_token`
- Local upstream API key: `runtime/kimi/.api-key`
- Vendor checkout/build: `.vendor/kimi-free-api`
- No browser or CDP is required during normal runtime.
- No paid Moonshot API key is used.

## Install

```bash
providers/kimi/engine/install.sh
```

The installer fetches the exact commit from `UPSTREAM.lock`, applies reviewed source patches, copies the token refresher and native Kimi Web project client, runs `gofmt`, `go vet`, and builds the binary.

## Authentication

The runtime uses the authenticated Kimi Web account session. `access_token` and `refresh_token` are persisted under `runtime/kimi/`; the Go runtime proactively refreshes the access token and is the only component that owns that credential lifecycle.

The WebChatProxy facade authenticates to the local Kimi runtime with `runtime/kimi/.api-key`. This is a local bridge credential, not a Moonshot API key.

## OpenAI-compatible API

- `GET /v1/models`
- `POST /v1/chat/completions`

## Project and conversation facade

The Kimi facade now exposes the native Kimi Web resources through normalized routes:

```text
GET  /v1/projects
GET  /v1/projects/{project_id}
GET  /v1/projects/{project_id}/files
GET  /v1/projects/{project_id}/conversations
POST /v1/projects/{project_id}/conversations
GET  /v1/conversations
GET  /v1/conversations/{conversation_id}
GET  /v1/conversations/{conversation_id}/messages
POST /v1/conversations/{conversation_id}/resume
```

On the universal gateway, add `provider=kimi` to read routes. The routing-only `provider` query parameter is removed before forwarding to the Kimi runtime.

Write routes preserve the caller JSON and only inject the route identity (`projectId` or `chatId`) before calling the Kimi Web RPC. This avoids inventing undocumented protocol fields.

## Native Kimi Web contracts

Project service:

```text
POST /apiv2/kimi.gateway.project.v1.ProjectService/ListProjects
POST /apiv2/kimi.gateway.project.v1.ProjectService/GetProject
POST /apiv2/kimi.gateway.project.v1.ProjectService/CreateProject
POST /apiv2/kimi.gateway.project.v1.ProjectService/UpdateProject
POST /apiv2/kimi.gateway.project.v1.ProjectService/DeleteProject
POST /apiv2/kimi.gateway.project.v1.ProjectService/ListProjectFiles
POST /apiv2/kimi.gateway.project.v1.ProjectService/SetChatProject
```

Chat service:

```text
POST /apiv2/kimi.gateway.chat.v1.ChatService/ListChats
POST /apiv2/kimi.gateway.chat.v1.ChatService/GetChat
POST /apiv2/kimi.gateway.chat.v1.ChatService/ListMessages
POST /apiv2/kimi.gateway.chat.v1.ChatService/ResumeChat
POST /apiv2/kimi.gateway.chat.v1.ChatService/Chat
POST /apiv2/kimi.gateway.chat.v1.ChatService/CreateChat
POST /apiv2/kimi.gateway.chat.v1.ChatService/UpdateChat
POST /apiv2/kimi.gateway.chat.v1.ChatService/DeleteChat
```

Live read-only validation confirmed `ListProjects`, `GetProject`, `ListChats` filtered by project, `GetChat`, `ListMessages`, and `ListProjectFiles` against the existing Kimi Web account using `access_token`/`refresh_token` only.

## Existing session controls

The pinned upstream also exposes:

- `GET /history`
- `POST /history`
- `POST /new`

These remain provider-native controls and are independent from the normalized project facade.

## Isolation

The upstream uses global conversation state guarded by a mutex. Treat one Kimi provider process as one serialized account/session domain. The Kimi runtime and token files remain isolated from ChatGPT, DeepSeek, Antigravity and Codex.
