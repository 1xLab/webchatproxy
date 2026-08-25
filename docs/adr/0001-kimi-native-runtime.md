# ADR 0001: Kimi Native Runtime

- Status: Proposed
- Date: 2026-08-25
- Issue: #10

## Context

The current Kimi provider is based on `izaart95-jpg/KimiFreeAPI`. That runtime
supports Kimi Web chat sessions through `chat_id`, `parent_id`, `/history`,
and `/new`, but it does not expose a project/workspace catalog or a queryable
conversation history API.

`MoonshotAI/kimi-cli` is an official Kimi Code implementation with a native
session API. It persists sessions by `work_dir`, exposes session listing,
search, archive, fork, files, and git diff, and groups sessions by project
workspace in its web UI.

These are not wire-compatible concepts. Replacing the runtime changes session
identity, persistence, authentication, filesystem access, and the provider
HTTP contract.

## Decision

Proposed: replace the Kimi provider runtime only if the target capability is
Kimi Code workspace projects and persisted sessions. The replacement must be
implemented behind the existing provider boundary and must preserve provider
isolation.

The implementation must explicitly map:

- Kimi Code `work_dir` to a provider project/workspace identifier.
- Kimi Code session IDs to `conversation_id`.
- Session list/search/archive/fork operations to provider-specific endpoints.
- Workspace files and git diff to explicit, authenticated endpoints.

The implementation must not claim support for Kimi Web cloud projects unless
the Kimi Web project API is separately identified and tested.

## Alternatives

### Keep KimiFreeAPI

Preserves the current Kimi Web chat behavior, but cannot provide native
projects or queryable history without implementing additional Kimi Web API
calls.

### Add a project layer above KimiFreeAPI

Would provide local project metadata, but it would not represent native Kimi
projects and would require a separate conversation persistence system.

### Use MoonshotAI/kimi-cli

Provides native workspace/session primitives, but requires a new runtime
adapter, filesystem policy, process lifecycle, and compatibility layer.

## Consequences

- A migration must define how existing `chat_id` sessions are handled.
- Provider capabilities must distinguish facade capabilities from native
  capabilities.
- The new runtime needs its own tests for project isolation, session listing,
  conversation continuation, archive/fork, file access, and git diff.
- Deployment must not share Kimi Code session storage with the current Kimi
  Web runtime.

## Acceptance criteria

- A real project/workspace can be listed and selected.
- Conversations can be listed, opened, continued, searched, and isolated by
  workspace.
- Existing Kimi provider chat completion remains independently testable.
- Authentication and runtime state are isolated from all other providers.
- The provider README documents the native and facade contracts separately.
