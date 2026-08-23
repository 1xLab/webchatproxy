# ChatGPT provider

Provider-specific implementation for ChatGPT Web.

Layout:

- `browser/`: authentication and legacy browser helpers.
- `engine/`: pinned ChatGPT-Web2API bridge and installer.
- `mcp/`: MCP adapter and smoke test.
- `web2api-engine.mjs`: Node facade used by the generic gateway runtime.

Compatibility shims remain in the former top-level paths so existing deployments and systemd units continue to work during the refactor.

Future providers must live in sibling directories under `server/providers/<provider>` and must own their browser profile, runtime state, ports and concurrency controls independently.
