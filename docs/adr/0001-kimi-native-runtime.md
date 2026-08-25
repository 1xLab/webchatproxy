# ADR 0001: Kimi Web Projects Runtime

- Status: Accepted
- Date: 2026-08-25
- Issue: #10

## Context

The current Kimi provider is based on `izaart95-jpg/KimiFreeAPI`. That runtime
authenticates a Kimi Web account with its web-session tokens and supports Kimi
Web chat sessions through `chat_id`, `parent_id`, `/history`, and `/new`.

The missing facade capability is the project and conversation API used by the
Kimi Web interface. Live validation against the authenticated Kimi Web account
confirmed `ProjectService` and `ChatService` methods for project discovery,
project conversations, files and persisted message history. `MoonshotAI/kimi-cli`
has workspace/session APIs, but those are a different state system and are not
a replacement for Kimi Web projects.

## Decision

Keep Kimi Web as the native runtime. Reverse-map the authenticated Kimi Web
project and conversation endpoints from the existing web session and implement
them behind the current Kimi provider boundary. Do not use a paid Moonshot API
key and do not replace the runtime with Kimi Code CLI.

The runtime maps:

- Kimi Web project identifiers to provider project identifiers.
- Kimi Web chat identifiers to `conversation_id` resources.
- Kimi Web history/continuation semantics to provider conversation methods.
- Kimi Web project files/context only through endpoints observed and validated
  against the real web account.

The OpenAI-compatible facade remains `POST /v1/chat/completions`. Project and
conversation resources are provider extensions on the same authenticated
runtime:

- `GET /v1/projects`
- `GET /v1/projects/{project_id}`
- `GET /v1/projects/{project_id}/files`
- `GET /v1/projects/{project_id}/conversations`
- `POST /v1/projects/{project_id}/conversations`
- `GET /v1/conversations`
- `GET /v1/conversations/{conversation_id}`
- `GET /v1/conversations/{conversation_id}/messages`
- `POST /v1/conversations/{conversation_id}/resume`

All endpoints use the existing Kimi Web `access_token`/`refresh_token` session
and never fall back to Moonshot API authentication. The Go Kimi runtime remains
the sole owner of token refresh so the Node facade does not introduce a second
credential lifecycle.

`kimi-cli` remains reference material for session/workspace UX only.

## Verified native contracts

The first live probes succeeded with the existing Kimi Web account session:

- `ProjectService/ListProjects` returned two Kimi Web projects.
- `ProjectService/GetProject` returned project metadata.
- `ChatService/ListChats` returned a chat filtered by `project_id`.
- `ChatService/GetChat` returned the chat's `projectId`.
- `ChatService/ListMessages` returned persisted message history.
- `ProjectService/ListProjectFiles` returned project files.

The exposed runtime also maps `CreateChat` and `ResumeChat` as authenticated
passthrough writes. Their JSON body is preserved and only the route identity
(`projectId` or `chatId`) is injected, avoiding invented Kimi protocol fields.

## Consequences

- Existing Kimi Web chats remain the source of truth.
- Kimi facade and native capability metadata now agree for projects,
  conversations and project files.
- Reverse-mapped endpoint contracts may change with the Kimi Web frontend and
  require live regression probes.
- No paid Moonshot API key or local Kimi Code session storage is introduced.
- The pinned Kimi runtime build must compile the project client together with
  the existing token refresher in CI.

## Acceptance criteria

- A real Kimi Web project can be listed and selected.
- Project conversations can be listed and opened with persisted history.
- Existing Kimi provider chat completion remains independently testable.
- Authentication and runtime state are isolated from all other providers.
- The provider README documents the Kimi Web native and facade contracts
  separately.
- The pinned Go runtime and Node facade tests pass before deployment.
