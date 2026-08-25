# Google Antigravity provider

OpenAI-compatible adapter around the official `agy` CLI.

Runtime contract:

- provider id: `antigravity`
- HTTP bind: `127.0.0.1:3240`
- `GET /health`
- `GET /v1/models` -> `agy models`
- `POST /v1/chat/completions` -> `agy -p ... --model ...`
- non-streaming uses `--output-format json`
- streaming uses `--output-format stream-json` and maps `agent_response.text_delta` to OpenAI SSE chunks
- Google authentication remains owned by `agy` and its user keyring/session under `HOME=/home/agent`
- provider API access is protected by `runtime/antigravity/.api-key`

## Install and authenticate

Run as the runtime user:

```bash
cd /home/agent/webchatproxy
bash providers/antigravity/engine/install.sh
bash providers/antigravity/engine/login.sh
```

The interactive `agy` login may open a browser locally or emit an authorization URL on SSH. Once authenticated, headless invocations reuse the cached Google credentials.

## Service

Install `systemd/webchat-antigravity.service`, then enable/start `webchat-antigravity.service`.

The provider-neutral MCP router exposes the same backend as provider `antigravity` through port 8100; it never falls back to another provider.

## Facade and native capabilities

The WebChatProxy facade exposes the `agy` model catalog and chat execution only. The native `agy` CLI supports project and conversation selection directly:

- `--project <id-or-name>` selects a project.
- `--new-project` creates a project for the session.
- `--conversation <id>` resumes a conversation.
- `--continue` resumes the most recent conversation.

Live validation of `/v1/projects` and `/v1/conversations` returning `404` describes the facade only; Google project/session state remains owned by the `agy` CLI.
