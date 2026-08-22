# webchatproxy

Standalone API proxy for consuming an authenticated ChatGPT Web account programmatically.

`webchatproxy` is an independent product. It has no frontend and does not depend on Laravel, PHP, `webagent`, `ws_com_ia`, a browser extension or the OpenAI API.

## Architecture

```text
HTTP / SDK clients
    |
    v
webchatproxy API :3210
    |
    +--> ResourceCatalog ----> runtime/catalog/projects.json
    +--> FileStore ----------> runtime/uploads/
    +--> JobManager ---------> queue / persistence / idempotency
    |
    v
Web2ApiEngine
    |
    v
internal loopback bridge :3211
    |
    v
ChatGPT-Web2API (pinned MIT dependency)
    |
    v
Chrome/CDP + persistent browser-profile
    |
    v
chatgpt.com
```

The normal runtime has one browser owner: the pinned `ChatGPT-Web2API` engine. The removed custom `chatgpt-control.mjs` implementation is not used as a fallback.

The public API binds to `127.0.0.1:3210` by default. The Python engine bridge is internal and loopback-only.

## Requirements

- Node.js 20+
- Python 3.11+
- Google Chrome or Chromium supported by the upstream engine
- a persistent authenticated ChatGPT Web browser profile
- Xvfb for headed Chrome on servers without a graphical display

The selected engine is pinned in `server/requirements-engine.txt` to a reviewed upstream commit.

## Quick start

```bash
cd server
npm ci
./start.sh engine-install
./start.sh browser-auth
./start.sh start
./start.sh doctor-live
```

`./start.sh start` also installs the pinned engine automatically when `.venv-engine` is missing, provided Python 3.11+ is available.

## Projects and old chats

Projects can be discovered from the authenticated ChatGPT account or imported by an administrator. Imported aliases keep API clients independent from ChatGPT display names.

Example `projects.json`:

```json
{
  "projects": {
    "auditor": {
      "id": "g-p-0123456789abcdef",
      "name": "Auditor",
      "aliases": ["bca", "detran"]
    },
    "finance": "g-p-fedcba9876543210"
  }
}
```

CLI import:

```bash
cd server
npm run catalog -- import projects.json
npm run catalog -- list
npm run catalog -- resolve auditor
```

API import/sync:

```text
POST /v1/projects/import
POST /v1/projects/sync
GET  /v1/projects
GET  /v1/projects?live=1
```

Conversation history:

```text
GET /v1/conversations
GET /v1/conversations/{conversation_id}
GET /v1/projects/{project-or-alias}/conversations
GET /v1/projects/{project-or-alias}/files
```

## Chat API

OpenAI-style synchronous request:

```bash
curl -X POST http://127.0.0.1:3210/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "auto",
    "project": "auditor",
    "messages": [{"role":"user","content":"Responda apenas: API_OK"}]
  }'
```

Continue an existing ChatGPT conversation:

```json
{
  "model": "auto",
  "conversation_id": "existing-chat-id",
  "messages": [
    {"role": "user", "content": "Continue a análise."}
  ],
  "new_conversation": false
}
```

`GET /v1/models` returns the model catalog read from the authenticated ChatGPT account through the engine.

## File staging

`POST /v1/files` accepts a raw binary body and stores it under `runtime/uploads/` with size, MIME type and SHA-256 metadata.

```bash
curl -X POST http://127.0.0.1:3210/v1/files \
  -H 'Content-Type: application/pdf' \
  -H 'X-Filename: evidence.pdf' \
  --data-binary @evidence.pdf
```

Important current boundary: the pinned ChatGPT-Web2API engine does not expose a safe per-message attachment operation. Therefore staging works, but using an `attachments` array in a chat request returns HTTP 501. The proxy fails closed rather than sending a prompt without the expected document.

Persistent Project knowledge-file upload/update/delete is also not claimed as implemented. `GET /v1/projects/{project}/files` reads Project file metadata.

## API

```text
GET    /health
GET    /ready
GET    /v1/account
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

Diagnostic endpoints remain under `/v1/debug/*`. Browser-DOM and screenshot debug calls intentionally return 501 because the upstream engine owns Chrome; engine diagnostics are exposed instead.

## Local state

Never commit:

```text
server/.venv-engine/
server/browser-profile/
server/runtime/
```

## Deployment

The repository name is independent from the installed runtime path. Existing production services remain under `/home/agent/server`.

```bash
WEBCHAT_DEPLOY_HOST=server.example \
WEBCHAT_DEPLOY_USER=agent \
./deploy.sh all
```

By default, `server/` is synchronized to `/home/$WEBCHAT_DEPLOY_USER/server/`. `browser-profile/` and `runtime/` are excluded from rsync so deploys preserve authentication and operational state.

Before restarting production after this engine migration, verify Python 3.11+ and install the engine:

```bash
cd /home/agent/server
./start.sh engine-install
npm run check
npm test
```

Then restart the existing gateway service and validate:

```bash
curl -sS http://127.0.0.1:3210/health
curl -sS http://127.0.0.1:3210/ready
npm run doctor:control
```

## Development

```bash
cd server
npm run check
npm test
npm run doctor:contract
```

CI validates that the custom ChatGPT backend implementation remains removed and that the public Node API can operate independently from any web application.
