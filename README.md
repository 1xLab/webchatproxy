# webchatproxy

API-only gateway repository for authenticated Web AI providers. Current providers are isolated siblings under `server/providers/` and can run independently in parallel.

## Canonical layout

```text
server/
├── bootstrap.mjs
├── standalone.mjs
├── doctor.mjs
├── catalog.mjs
├── start.sh
├── test.sh
├── providers/
│   ├── chatgpt/
│   │   ├── gateway-runtime.mjs
│   │   ├── http-api.mjs
│   │   ├── job-manager.mjs
│   │   ├── web2api-engine.mjs
│   │   ├── browser/auth.mjs
│   │   ├── engine/
│   │   │   ├── install.sh
│   │   │   ├── requirements.txt
│   │   │   └── web2api_bridge.py
│   │   └── mcp/
│   │       ├── server.py
│   │       └── smoke.py
│   └── deepseek/
│       ├── README.md
│       └── engine/
│           ├── UPSTREAM.lock
│           ├── install.sh
│           ├── login.sh
│           └── start.sh
└── systemd/
    ├── webchat-gateway.service
    ├── webchat-mcp.service
    └── webchat-deepseek.service
```

No legacy `server/lib/`, `server/engine/` or root browser shims exist.

## ChatGPT provider

```text
HTTP client
   ↓
127.0.0.1:3210
   ↓
providers/chatgpt/http-api.mjs
   ↓
GatewayRuntime / JobManager
   ↓
Web2ApiEngine
   ↓
127.0.0.1:3211
   ↓
ChatGPT-Web2API pinned engine
   ↓
Chrome/CDP :9222
   ↓
chatgpt.com
```

MCP is a separate process on `127.0.0.1:8090` and forwards to the same bridge. It does not own a second Chrome process.

Explicit install and authentication:

```bash
cd server
npm ci
./start.sh engine-install
./start.sh browser-auth
```

Runtime startup never installs the ChatGPT engine automatically.

## DeepSeek provider

DeepSeek is a separate sidecar provider using the reviewed MIT upstream `kittors/deepseek-web-api`, pinned in `server/providers/deepseek/engine/UPSTREAM.lock`.

Default isolation:

```text
HTTP          127.0.0.1:3220
Chrome CDP    127.0.0.1:9333
profile       server/browser-profile-deepseek/
data          server/runtime/deepseek/
installed src server/.vendor/deepseek-web-api/
```

Install is explicit. The installer fetches only the exact pinned commit, verifies the checkout, installs the frozen pnpm lockfile, runs typecheck, lint, tests and build, and only then leaves a runnable provider:

```bash
cd server
npm run deepseek:install
```

Login and start are separate operations:

```bash
npm run deepseek:login
npm run deepseek:start
```

`providers/deepseek/engine/start.sh` never downloads or updates the engine. It fails if the pinned build is missing or if the installed checkout does not match the locked commit.

ChatGPT and DeepSeek do not share a browser profile, CDP port, process or queue and can run simultaneously.

## ChatGPT API

Primary endpoints on `127.0.0.1:3210`:

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

Write and destructive ChatGPT operations remain controlled by:

```text
W2A_ENABLE_WRITE
W2A_ENABLE_DESTRUCTIVE
```

The DeepSeek sidecar exposes the OpenAI-compatible API implemented by its pinned upstream on `127.0.0.1:3220`.

## Provider isolation

New providers are added as siblings, never inside another provider implementation:

```text
providers/
├── chatgpt/
├── deepseek/
├── kimi/
└── ...
```

Each provider owns its process state, browser profile, ports and concurrency policy. There is no global browser or provider lock.

## Local state

Never commit:

```text
server/.venv-chatgpt/
server/.vendor/
server/browser-profile/
server/browser-profile-deepseek/
server/runtime/
```

## Validation

```bash
cd server
npm ci
npm run check
npm test
npm run doctor:contract
```

CI also installs and validates the exact pinned ChatGPT and DeepSeek upstream engines. Authenticated live generation still requires the corresponding logged-in runtime environment.

## Deployment

Canonical installed path:

```text
/home/agent/webchatproxy
```

Provider engines are installed explicitly during deployment or maintenance; runtime startup does not fetch dependencies.
