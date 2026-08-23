# Provider-neutral MCP router

This MCP server exposes the installed `webchatproxy` providers through one explicit, provider-neutral tool surface.

## Providers

- `chatgpt` → `http://127.0.0.1:3210`
- `deepseek` → `http://127.0.0.1:3220`
- `kimi` → `http://127.0.0.1:3230`

There is no implicit fallback. Every generation call requires an explicit provider.

## Tools

- `list_providers`
- `provider_health`
- `list_models`
- `chat_completion`

`chat_completion` accepts either `message` or an OpenAI-style `messages` array. It always calls the selected provider with `stream: false` and returns the selected provider identity together with the upstream response.

## Transports

- stdio for local clients
- SSE on `127.0.0.1:8100/sse` through `webchat-mcp-router.service`

Optional SSE authentication can be configured with `WEBCHAT_ROUTER_MCP_TOKEN` in `runtime/mcp-router.env`.

The existing ChatGPT-specific MCP service on port 8090 is intentionally left intact. This router is a separate generic surface and does not rename ChatGPT-specific capabilities into generic ones.
