# ChatGPT Resource Control Plane

## Goal

`webchatproxy` exposes a stable API over an authenticated ChatGPT Web account. It is a proxy core for API consumption, not a UX product.

Remote resources are modeled as:

```text
ChatGPT account
  +-- Projects (g-p-*)
  |     +-- Project metadata
  |     +-- Project file metadata
  |     +-- conversations
  +-- global conversations
  +-- conversation history
```

Clients target resources with `project`, `project_id` and `conversation_id`; they do not need to know ChatGPT DOM or internal endpoint details.

## Engine architecture

The normal browser owner is the pinned MIT `ChatGPT-Web2API` engine.

```text
API client
   |
   v
webchatproxy :3210
   |
   +-- auth / jobs / aliases / staging / diagnostics
   |
   v
Web2ApiEngine
   |
   v
internal bridge :3211 (loopback only)
   |
   v
ChatGPT-Web2API
   |
   v
Chrome/CDP + persistent browser-profile
   |
   v
chatgpt.com
```

The former custom `ChatGptControl` implementation was removed. `webchatproxy` does not maintain a parallel JavaScript implementation of ChatGPT `/backend-api/*` reads.

The upstream engine owns session/token handling, CDP lifecycle, model discovery/selection, Projects, conversations, Project-file metadata, chat navigation, retries, locks, breakers and ChatGPT Web drift handling.

MCP is not exposed as part of this product. The public contract remains HTTP `/v1/*`.

## Project catalog

Local operational metadata is stored under:

```text
server/runtime/catalog/projects.json
```

It stores ChatGPT Project IDs, display names, administrator aliases and observed metadata. Imports merge by Project ID; live sync enriches the catalog while retaining administrator aliases.

Example:

```json
{
  "projects": {
    "alpha": {
      "id": "g-p-abc",
      "aliases": ["customer-a"]
    }
  }
}
```

## Targeting chats

New global chat:

```json
{
  "model": "auto",
  "messages": [{"role":"user","content":"..."}],
  "new_conversation": true
}
```

New Project chat:

```json
{
  "model": "auto",
  "project": "alpha",
  "messages": [{"role":"user","content":"..."}],
  "new_conversation": true
}
```

Continue an existing chat:

```json
{
  "model": "auto",
  "conversation_id": "...",
  "messages": [{"role":"user","content":"..."}],
  "new_conversation": false
}
```

Project aliases are resolved locally to authoritative `g-p-*` IDs before the engine call.

## File staging and current attachment boundary

Clients can stream binary files to:

```text
POST /v1/files
X-Filename: source.pdf
Content-Type: application/pdf
<body = raw bytes>
```

Files are stored under `runtime/uploads/upl_<uuid>/` with SHA-256, size, MIME and creation metadata. Public jobs expose staging IDs, never server filesystem paths.

The pinned ChatGPT-Web2API engine does not currently expose a safe per-message attachment operation. Therefore a chat request containing `attachments` returns HTTP 501. This is deliberate fail-closed behavior: the proxy must never send a prompt while silently dropping a requested document.

Project source-file mutation is a separate capability and is also not claimed as implemented. Project file metadata reads are supported.

## API surface

```text
GET    /health
GET    /ready
GET    /v1/models
GET    /v1/projects
POST   /v1/projects/import
POST   /v1/projects/sync
GET    /v1/projects/{project}/conversations
GET    /v1/projects/{project}/files
GET    /v1/conversations
GET    /v1/conversations/{id}
POST   /v1/files
GET    /v1/files/{id}
DELETE /v1/files/{id}
POST   /v1/jobs
GET    /v1/jobs
GET    /v1/jobs/{id}
GET    /v1/jobs/{id}/events
DELETE /v1/jobs/{id}
POST   /v1/chat/completions
```

`GET /v1/projects` defaults to the local catalog. `GET /v1/projects?live=1` and `POST /v1/projects/sync` use the authenticated upstream engine.

## Reliability rules

1. Keep ChatGPT session tokens/cookies out of the public API and diagnostics.
2. Keep exactly one normal browser owner: ChatGPT-Web2API.
3. Keep the internal engine bridge on loopback.
4. Pin the upstream engine commit for reproducible deployments.
5. Fail closed for unsupported controls such as attachments and `reasoning_effort`.
6. Do not inject gateway account metadata into user prompts.
7. Keep Project aliases/local catalog separate from ChatGPT source-of-truth IDs.
8. Never relocate `/home/agent/server`, its `browser-profile` or `runtime` as part of this migration.

## Production paths

```text
/home/agent/server
/home/agent/server/browser-profile
/home/agent/server/runtime
```

Engine virtualenv:

```text
/home/agent/server/.venv-engine
```

Control-plane state remains under the existing runtime tree:

```text
/home/agent/server/runtime/catalog/
/home/agent/server/runtime/uploads/
```
