# Agent Contract

Canonical repository: `1xLab/webchatproxy`
Canonical branch: `main`

## Scope

`webchatproxy` is an API-only gateway for authenticated Web AI providers. Provider implementations are isolated under `server/providers/<provider>/`.

The current provider is ChatGPT Web. It uses the pinned ChatGPT-Web2API engine and owns its ChatGPT-specific HTTP runtime, jobs, catalog, MCP process and browser authentication maintenance inside `server/providers/chatgpt/`.

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

Forbidden legacy paths:

```text
server/lib/
server/engine/
server/browser-auth.mjs
server/browser-backend.mjs
server/requirements-engine.txt
```

## Runtime state

Private local state:

```text
server/.venv-chatgpt/
server/browser-profile/
server/runtime/
```

Runtime startup verifies dependencies and fails if they are missing. It must never install/download the engine implicitly. Installation is an explicit deployment operation:

```bash
cd server
npm ci
./start.sh engine-install
npm run check
npm test
```

## Provider isolation

Each future provider must own its browser/session state, engine/CDP ports, MCP process and concurrency controls independently. Do not introduce a global provider queue or a global browser lock.

Operations that mutate the same remote conversation may be serialized inside that provider; unrelated conversations/providers must remain capable of parallel execution.

## Development

Changes are committed directly to `main` for this repository. Before considering a change complete, run the available syntax checks, tests and contract checks and verify that CI is green.

Never claim production readiness based only on static review. Authenticated live generation and service startup require the production/preflight environment.
