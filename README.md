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

## API

```text
GET    /health
GET    /ready
GET    /v1/account
GET    /v1/models
POST   /v1/jobs
GET    /v1/jobs
GET    /v1/jobs/{id}
GET    /v1/jobs/{id}/events
DELETE /v1/jobs/{id}
POST   /v1/chat/completions
```

Diagnostic endpoints are documented in `docs/DEBUG_CONTRACT.md`.

## Local state

Never commit:

```text
server/browser-profile/
server/runtime/
```

## Deployment

```bash
WEBCHAT_DEPLOY_HOST=server.example \
WEBCHAT_DEPLOY_USER=webchat \
WEBCHAT_DEPLOY_ROOT=/opt/webchatproxy \
./deploy.sh all
```

`WEBCHAT_DEPLOY_ROOT` defaults to `/home/$WEBCHAT_DEPLOY_USER/webchatproxy`.

## Development

```bash
cd server
npm run check
npm test
npm run doctor:contract
```

CI executes the standalone proxy contract on every pull request.
