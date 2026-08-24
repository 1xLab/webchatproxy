# webchatproxy

Fresh universal provider runtime for OpenAI-compatible chat backends.

## Architecture

```text
clients (Kilo / WebAgent / MCP / HTTP)
            |
            v
      Universal Gateway :3200
            |
            v
      Universal JobManager
       /      |      |      \
  ChatGPT DeepSeek  Kimi  Antigravity
```

The core owns jobs, idempotency, persistence, provider concurrency, timeouts and conversation IDs. Provider adapters own transport, authentication/runtime recovery and provider-specific capabilities.

## HTTP

- `GET /health`
- `GET /v1/providers`
- `GET /v1/models?provider=<id>`
- `POST /v1/chat/completions`
- `POST /v1/jobs`
- `GET /v1/jobs`
- `GET /v1/jobs/:id`
- `DELETE /v1/jobs/:id`

`POST /v1/chat/completions` accepts `provider`, `model`, `messages`, optional `conversation_id`, optional `request_id`, and optional `async`.

## Providers

Default local upstreams:

- ChatGPT `http://127.0.0.1:3210`
- DeepSeek `http://127.0.0.1:3220`
- Kimi `http://127.0.0.1:3230`
- Antigravity `http://127.0.0.1:3240`

These are adapters, not fallback routes. An explicit provider is always required.

## Run

```bash
cd server
npm test
npm start
```
