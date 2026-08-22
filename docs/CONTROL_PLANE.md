# ChatGPT Resource Control Plane

## Goal

`webchatproxy` should control a persistent ChatGPT Web account as a resource graph, not merely as a prompt textbox.

The proxy therefore models these remote entities explicitly:

```text
ChatGPT account
  |
  +-- Projects (g-p-*)
  |     |
  |     +-- project metadata/instructions/memory
  |     +-- project source-file metadata
  |     +-- conversations
  |
  +-- global conversations
  |
  +-- conversation message trees
```

Clients interact with stable proxy API fields such as `project`, `project_id`, `conversation_id` and staged attachment IDs. They do not need to know the ChatGPT sidebar layout.

## Hybrid browser strategy

### Read plane

Project lists, project metadata, conversation lists and full conversation history are read through authenticated ChatGPT Web backend GET requests executed inside the persistent Chromium context.

```text
API request
   |
   v
ChatGptControl
   |
   | page.evaluate(fetch)
   v
logged-in ChatGPT origin
   |
   v
/backend-api/*
```

The access token obtained from `/api/auth/session` is used only inside browser JavaScript and is never returned to Node clients, persisted by the proxy or exposed through diagnostics.

Observed useful read endpoints include:

```text
GET /backend-api/gizmos/snorlax/sidebar
GET /backend-api/gizmos/{project_id}
GET /backend-api/gizmos/{project_id}/conversations
GET /backend-api/conversations
GET /backend-api/conversation/{conversation_id}
```

These are ChatGPT Web implementation details, not a public OpenAI API contract. They can change. The proxy owns adaptation and diagnostics for that drift.

### Action plane

Actions likely to encounter ChatGPT anti-bot/write protections are executed through the real UI:

```text
project/chat target
      |
      v
Playwright direct navigation
      |
      +-- setInputFiles for staged attachments
      +-- real composer send
      |
      v
ChatGPT frontend
```

The browser frontend remains responsible for whatever current challenges/tokens are needed for a legitimate logged-in interactive send.

## Project catalog

The local catalog is operational metadata, not a copy of ChatGPT data.

Location:

```text
server/runtime/catalog/projects.json
```

It stores:

- ChatGPT `g-p-*` project ID;
- display name;
- imported aliases;
- known project URL / `short_url`;
- workspace ID when observed;
- project instructions/memory metadata when observed;
- project file metadata when observed;
- import/live-observation timestamps.

Resolution order favors known URL/`short_url`/aliases, then direct project ID. This is important because ChatGPT project `short_url` values may contain a human-readable suffix after the project identifier.

### Import formats

Array:

```json
{
  "projects": [
    {"id":"g-p-abc", "name":"Alpha", "aliases":["a"]}
  ]
}
```

Admin map:

```json
{
  "projects": {
    "alpha": "g-p-abc",
    "beta": {
      "id":"g-p-def",
      "aliases":["customer-b"]
    }
  }
}
```

Imports merge by project ID. A later live sync enriches metadata without intentionally discarding administrator aliases.

## Targeting a chat

A job can target exactly one of the following logical modes.

### New global chat

```json
{
  "messages":[{"role":"user","content":"..."}],
  "new_conversation":true
}
```

### New chat inside a Project

```json
{
  "project":"alpha",
  "messages":[{"role":"user","content":"..."}],
  "new_conversation":true
}
```

The catalog resolves `alpha` to a project ID/URL and Playwright navigates directly to the project URL. Sidebar discovery is unnecessary on the send path.

### Continue an existing chat

```json
{
  "conversation_id":"...",
  "messages":[{"role":"user","content":"..."}],
  "new_conversation":false
}
```

A known conversation ID is authoritative. The proxy navigates directly to that chat and continues it.

## Attachment staging

Client filesystem paths must never be accepted as remote API paths. A client first streams a binary object to:

```text
POST /v1/files
X-Filename: source.pdf
Content-Type: application/pdf
<body = raw bytes>
```

The proxy stores it under:

```text
server/runtime/uploads/upl_<uuid>/
```

Metadata includes SHA-256, byte size, MIME type and creation time. File mode is restricted and a retention cleanup removes old staged uploads.

The job carries only staging IDs:

```json
"attachments": ["upl_..."]
```

Only immediately before browser execution does `JobManager` resolve those IDs to local absolute paths. Those paths are never part of the public job representation.

Playwright then calls `setInputFiles`. The driver waits for evidence that ChatGPT accepted the filename before it sends the prompt. Failure to attach is fatal to the job; the proxy must never silently submit a prompt that was supposed to include a document.

## Message attachments vs Project source files

These are deliberately separate concepts:

- **message attachment**: file attached to one prompt/chat turn;
- **Project source file**: persistent file in the Project's configured knowledge/context.

The current control-plane slice implements message attachments and read-only Project-file metadata. Persistent Project source-file mutation should be implemented as an explicit Project operation after its current ChatGPT UI/backend flow is verified. It must not be faked by sending a normal chat attachment.

## API surface

```text
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
POST   /v1/chat/completions
```

`GET /v1/projects` defaults to the local catalog for low latency. `?live=1` reads the authenticated ChatGPT account. `POST /v1/projects/sync` refreshes the catalog from live data.

## Reliability rules

1. Never expose ChatGPT session cookies or access tokens through the proxy API.
2. Never scrape the sidebar for data that can be read reliably as structured authenticated JSON.
3. Never use an undocumented write endpoint when the normal frontend can safely perform the same operation and absorb its challenge flow.
4. Never send a prompt after a requested attachment failed to attach.
5. Never relocate `/home/agent/server`, its browser profile or runtime as part of this feature.
6. Treat undocumented ChatGPT endpoints/selectors as adapters that can drift; contain them behind `ChatGptControl` and `BrowserBackend`.
7. Keep admin aliases/local catalog separate from remote ChatGPT source-of-truth IDs.

## Deployment state

Repository source remains `1xLab/webchatproxy`, while the existing production service remains under:

```text
/home/agent/server
/home/agent/server/browser-profile
/home/agent/server/runtime
```

The control-plane state therefore lands under the existing runtime tree after deployment:

```text
/home/agent/server/runtime/catalog/
/home/agent/server/runtime/uploads/
```

No service path migration is required.
