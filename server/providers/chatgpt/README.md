# ChatGPT provider

Canonical ChatGPT Web implementation for `webchatproxy`.

```text
providers/chatgpt/
├── gateway-runtime.mjs
├── http-api.mjs
├── event-journal.mjs
├── file-store.mjs
├── job-manager.mjs
├── resource-catalog.mjs
├── web2api-engine.mjs
├── browser/
│   └── auth.mjs
├── engine/
│   ├── install.sh
│   ├── requirements.txt
│   └── web2api_bridge.py
└── mcp/
    ├── server.py
    └── smoke.py
```

The provider owns its engine integration, browser authentication maintenance, MCP server, queue/persistence and ChatGPT-specific API surface. There are no compatibility shims outside this directory.

The normal runtime has one Chrome/CDP owner: the pinned ChatGPT-Web2API engine. `browser/auth.mjs` exists only for explicit human login maintenance and must never run concurrently with the gateway.

## HTTP contract

The Web2API bridge listens on `127.0.0.1:3311`; the Node runtime facade listens on `127.0.0.1:3310` and mirrors the same project contract.

- `GET /health`
- `GET /v1/models`
- `GET /v1/projects`
- `POST /v1/projects`
- `DELETE /v1/projects/{project_id}`
- `PATCH /v1/projects/{project_id}/instructions`
- `GET /v1/projects/{project_id}/files`
- `GET /v1/projects/{project_id}/conversations`
- `GET /v1/conversations?project_id={project_id}`
- `GET /v1/conversations/{conversation_id}`
- `POST /v1/conversations/{conversation_id}/archive`
- `DELETE /v1/conversations/{conversation_id}`
- `POST /v1/chat/completions`

Project conversation filtering uses the ChatGPT project id (`g-p-...`). The bridge may scan conversation pages for this filter; use a bounded `limit` for interactive calls.

Future Web providers belong in sibling directories under `providers/<provider>/` and must use independent browser profiles, runtime state, engine/CDP ports and concurrency controls. A provider failure must not require another provider to stop.
