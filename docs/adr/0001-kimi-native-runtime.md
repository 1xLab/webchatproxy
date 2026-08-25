# ADR 0001: Kimi Web Projects Runtime

- Status: Proposed
- Date: 2026-08-25
- Issue: #10

## Context

The current Kimi provider is based on `izaart95-jpg/KimiFreeAPI`. That runtime
authenticates a Kimi Web account with its web-session tokens and supports Kimi
Web chat sessions through `chat_id`, `parent_id`, `/history`, and `/new`.

The missing facade capability is the project and conversation API used by the
Kimi Web interface. The live Kimi Web Connect descriptors identify
`ProjectService` and `ChatService` methods for project discovery, project
conversations, files, history and continuation. `MoonshotAI/kimi-cli` has
workspace/session APIs, but those are a different state system and are not a
replacement for Kimi Web projects.

These are not wire-compatible concepts. Replacing the runtime changes session
identity, persistence, authentication, filesystem access, and the provider
HTTP contract.

## Decision

Decision: keep Kimi Web as the native runtime. Reverse-map the authenticated
Kimi Web project and conversation endpoints from the existing web session and
implement them behind the current Kimi provider boundary. Do not use a paid
Moonshot API key and do not replace the runtime with Kimi Code CLI.

The implementation must explicitly map:

- Kimi Web project identifiers to provider project identifiers.
- Kimi Web chat identifiers to `conversation_id`.
- Kimi Web history/continuation semantics to provider conversation methods.
- Kimi Web project context/files only when the web interface exposes them and
  the behavior is verified against a real account.

The implementation must not claim support for Kimi Web cloud projects unless
the Kimi Web project API is separately identified and tested.

## Investigation boundary

The OpenAI-compatible facade remains `POST /v1/chat/completions`. Project and
conversation resources are provider-specific extensions on the same runtime:

- `GET /v1/projects`
- `GET /v1/projects/{project_id}`
- `GET /v1/projects/{project_id}/conversations`
- `GET /v1/conversations`
- `GET /v1/conversations/{conversation_id}`
- `POST /v1/projects/{project_id}/conversations`

All endpoints must use the existing Kimi Web `access_token`/`refresh_token`
session and must not fall back to Moonshot API authentication.

`kimi-cli` remains a reference for session listing and workspace UX only.

The first live read-only probes succeeded with the existing account session:

- `ProjectService/ListProjects` returned two Kimi Web projects.
- `ProjectService/GetProject` returned project metadata.
- `ChatService/ListChats` returned a chat filtered by `project_id`.
- `ChatService/GetChat` returned the chat's `projectId`.
- `ChatService/ListMessages` returned persisted message history.
- `ProjectService/ListProjectFiles` returned the project file root.

## Consequences

- Existing Kimi Web `chat_id` sessions remain the source of truth.
- Provider capabilities must distinguish facade capabilities from native
  capabilities.
- Reverse-mapped endpoint contracts may change with the Kimi Web frontend and
  require live regression probes.
- No paid Moonshot API key or local Kimi Code session storage is introduced.

## Acceptance criteria

- A real Kimi Web project can be listed and selected.
- Project conversations can be listed, opened, continued and isolated.
- Existing Kimi provider chat completion remains independently testable.
- Authentication and runtime state are isolated from all other providers.
- The provider README documents the Kimi Web native and facade contracts
  separately.
