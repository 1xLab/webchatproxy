# webchatproxy

API-only gateway for authenticated Web AI providers. The current provider is ChatGPT Web; additional providers are added as independent siblings under `server/providers/`.

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
│   └── chatgpt/
│       ├── gateway-runtime.mjs
│       ├── http-api.mjs
│       ├── job-manager.mjs
│       ├── web2api-engine.mjs
│       ├── browser/auth.mjs
│       ├── engine/
│       │   ├── install.sh
│       │   ├── requirements.txt
│       │   └── web2api_bridge.py
│       └── mcp/
│           ├── server.py
│           └── smoke.py
└── systemd/
```

No legacy `server/lib/`, `server/engine/` or root browser shims exist.

## ChatGPT runtime

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

## Install

Requirements:

- Node.js 20+
- Python 3.11+
- Google Chrome
- Xvfb for headed Chrome on a server without an existing display

Install is explicit:

```bash
cd server
npm ci
./start.sh engine-install
npm run check
npm test
```

Runtime startup never downloads or installs the Python engine. Missing dependencies are a startup error.

The reviewed upstream is pinned in:

```text
server/providers/chatgpt/engine/requirements.txt
```

## Authentication

Interactive login is maintenance, not normal runtime:

```bash
cd server
./start.sh browser-auth
```

The gateway must be stopped while the canonical browser profile is opened for manual login.

## Start and diagnostics

```bash
./start.sh start
./start.sh status
npm run doctor:control
npm run doctor:live
```

Default ports:

```text
3210  public loopback HTTP API
3211  internal ChatGPT engine bridge
9222  ChatGPT Chrome CDP
8090  ChatGPT MCP SSE
```

## API

Primary endpoints:

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

Write and destructive ChatGPT operations remain controlled by the upstream-compatible gates:

```text
W2A_ENABLE_WRITE
W2A_ENABLE_DESTRUCTIVE
```

## Provider isolation

Future providers are not added inside the ChatGPT implementation. Each provider receives its own directory and independently owned process state, browser profile, CDP/engine ports and concurrency policy.

```text
providers/
├── chatgpt/
├── deepseek/
├── kimi/
└── ...
```

This allows providers and independent conversations to execute concurrently without a global browser or provider lock.

## Local state

Never commit:

```text
server/.venv-chatgpt/
server/browser-profile/
server/runtime/
```

## Deployment

Canonical installed path:

```text
/home/agent/webchatproxy
```

`deploy.sh` preserves `browser-profile/` and `runtime/`, installs the provider engine explicitly, runs checks/tests, and only then restarts the service.
