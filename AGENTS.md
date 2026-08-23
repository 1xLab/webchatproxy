# Agent Contract

Canonical repository: `1xLab/webchatproxy`
Canonical branch: `main`

## Scope

`webchatproxy` is an API-only gateway repository for authenticated Web AI providers. Provider implementations are isolated under `server/providers/<provider>/` and may run concurrently as independent services.

Current providers:

- `server/providers/chatgpt/`: pinned ChatGPT-Web2API integration, public gateway runtime, jobs/catalog, MCP and ChatGPT authentication maintenance.
- `server/providers/deepseek/`: pinned `kittors/deepseek-web-api` integration with its own runtime, CDP endpoint, browser profile and data directory.

Do not create compatibility shims for moved files. Migrations update every caller and delete obsolete paths in the same change.

## Canonical ChatGPT paths

```text
server/providers/chatgpt/gateway-runtime.mjs
server/providers/chatgpt/http-api.mjs
server/providers/chatgpt/job-manager.mjs
server/providers/chatgpt/web2api-engine.mjs
server/providers/chatgpt/browser/auth.mjs
server/providers/chatgpt/engine/web2api_bridge.py
server/providers/chatgpt/engine/requirements.txt
server/providers/chatgpt/mcp/server.py
server/providers/chatgpt/mcp/smoke.py
```

## Canonical DeepSeek paths

```text
server/providers/deepseek/README.md
server/providers/deepseek/engine/UPSTREAM.lock
server/providers/deepseek/engine/install.sh
server/providers/deepseek/engine/login.sh
server/providers/deepseek/engine/start.sh
server/systemd/webchat-deepseek.service
```

DeepSeek defaults:

```text
HTTP  127.0.0.1:3220
CDP   127.0.0.1:9333
state server/runtime/deepseek/
profile server/browser-profile-deepseek/
```

Forbidden legacy paths:

```text
server/lib/
server/engine/
server/browser-auth.mjs
server/browser-backend.mjs
server/requirements-engine.txt
```

## Runtime state

Private local state must never be committed:

```text
server/.venv-chatgpt/
server/.vendor/
server/browser-profile/
server/browser-profile-deepseek/
server/runtime/
```

Runtime startup verifies dependencies and fails if they are missing. It must never install/download provider engines implicitly. Installation is an explicit deployment operation.

ChatGPT:

```bash
cd server
npm ci
./start.sh engine-install
```

DeepSeek:

```bash
cd server
npm run deepseek:install
npm run deepseek:login
npm run deepseek:start
```

## Provider isolation

Every provider owns its browser/session state, engine/CDP ports, process lifecycle and concurrency controls independently. Do not introduce a global provider queue or a global browser lock.

Operations that mutate the same remote conversation may be serialized inside that provider; unrelated conversations and providers must remain capable of parallel execution.

## Development

Changes are committed directly to `main` for this repository. Before considering a change complete, run the available syntax checks, tests and contract checks and verify CI.

Never claim production readiness based only on static review. Authenticated live generation and service startup require the production/preflight environment.
