# Architecture

`webchatproxy` keeps provider implementations isolated. The repository is shared; runtime ownership is not.

## ChatGPT provider

```text
HTTP / SDK clients
        |
        v
127.0.0.1:3210
        |
providers/chatgpt/http-api.mjs
        |
providers/chatgpt/gateway-runtime.mjs
        |
   +----+--------------------+
   |                         |
JobManager             ResourceCatalog/FileStore
   |
Web2ApiEngine
   |
127.0.0.1:3211
   |
providers/chatgpt/engine/web2api_bridge.py
   |
pinned ChatGPT-Web2API
   |
Chrome/CDP :9222
   |
chatgpt.com
```

MCP runs independently on `127.0.0.1:8090` from `providers/chatgpt/mcp/server.py` and forwards to the same loopback engine. It never creates another Chrome/CDP owner.

## Directory rule

Provider-specific behavior belongs under:

```text
server/providers/<provider>/
```

There are no compatibility directories or duplicate provider entrypoints at `server/lib/`, `server/engine/` or the server root.

Future providers are siblings rather than branches inside ChatGPT code:

```text
providers/
├── chatgpt/
├── deepseek/
├── kimi/
└── ...
```

Each provider owns independent engine/browser state, ports and concurrency controls. Failure or restart of one provider must not require stopping another.

## Concurrency

There is no repository-wide provider mutex. Providers and unrelated sessions are expected to run in parallel. When a remote service requires ordered mutation of one conversation, locking belongs to that provider and that conversation key only.

## Persistent state

For ChatGPT the current canonical state remains:

```text
server/browser-profile/
server/runtime/
server/.venv-chatgpt/
```

These are local deployment state and are never committed. Moving source code must not silently relocate or destroy authenticated browser state.

## Installation boundary

Dependency installation is explicit deployment work. Normal service startup verifies the installed engine and fails closed when it is missing; startup does not download packages.

## Public boundary

External consumers use the HTTP or MCP contracts. They do not import provider internals or read browser/runtime state directly.
