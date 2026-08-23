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

Future Web providers belong in sibling directories under `providers/<provider>/` and must use independent browser profiles, runtime state, engine/CDP ports and concurrency controls. A provider failure must not require another provider to stop.
