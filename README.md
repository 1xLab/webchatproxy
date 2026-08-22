# webchatproxy

Standalone HTTP proxy for automating an authenticated ChatGPT Web session through Playwright.

`webchatproxy` is an independent product. It does not depend on Laravel, PHP, `webagent`, `ws_com_ia`, a browser extension, or the OpenAI API.

## Architecture

```text
HTTP clients
    |
    v
webchatproxy API :3210
    |
    +--> ResourceCatalog ----> runtime/catalog/projects.json
    +--> ChatGptControl -----> authenticated backend GET reads
    +--> FileStore ----------> runtime/uploads/
    |
    v
JobManager
    |
    v
BrowserBackend
    |
    v
Playwright + persistent browser profile
    |
    v
chatgpt.com
```

The control plane intentionally uses two strategies:

- project/history/model-style reads use authenticated ChatGPT Web backend GET requests executed inside the logged-in browser context;
- chat sends and document attachments use the real ChatGPT Web UI through Playwright.

This avoids expensive sidebar scraping for discovery while leaving anti-bot protected write flows to the real browser.

The default bind address is `127.0.0.1:3210`.

## Requirements

- Node.js 20+
- Playwright/Chromium
- a persistent ChatGPT Web browser profile
- Xvfb when running headed Chromium on a server without a graphical display

## Quick start

```bash
cd server
npm ci
./start.sh browser-install
./start.sh browser-auth
./start.sh start
./start.sh doctor-live
```

## Projects and old chats

Projects can be discovered live from the authenticated account or imported by an administrator. Imported aliases make API clients independent from ChatGPT display names.

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

## Message attachments

Binary files are staged locally before a chat job. The upload endpoint accepts the raw file body, not base64.

```bash
curl -X POST http://127.0.0.1:3210/v1/files \
  -H 'Authorization: Bearer ...' \
  -H 'Content-Type: application/pdf' \
  -H 'X-Filename: evidence.pdf' \
  --data-binary @evidence.pdf
```

The response returns an ID such as `upl_<uuid>`. Use that ID in a job or chat completion:

```json
{
  "model": "chatgpt-web",
  "project": "auditor",
  "messages": [{"role": "user", "content": "Analise o documento."}],
  "attachments": ["upl_..."],
  "new_conversation": true
}
```

To continue an old chat instead:

```json
{
  "model": "chatgpt-web",
  "conversation_id": "existing-chat-id",
  "messages": [{"role": "user", "content": "Continue a análise."}],
  "new_conversation": false
}
```

Staged files are hashed with SHA-256 and stored under `runtime/uploads/`. They are not committed to Git. This feature attaches files to a message; persistent Project source-file management is a separate operation and is not conflated with message attachments.

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

Diagnostic endpoints are documented in `docs/DEBUG_CONTRACT.md`. The extended control-plane design is documented in `docs/CONTROL_PLANE.md`.

## Local state

Never commit:

```text
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

By default, `server/` is synchronized to `/home/$WEBCHAT_DEPLOY_USER/server/`. Use `WEBCHAT_DEPLOY_HOME` only when the existing service home differs.

`browser-profile/` and `runtime/` are excluded from rsync, so deploys preserve the authenticated browser session and operational state already present on the server.

## Development

```bash
cd server
npm run check
npm test
npm run doctor:contract
```

CI executes the standalone proxy contract on every push to development branches and on every pull request.
