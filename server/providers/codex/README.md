# Codex provider

OAuth-backed Codex Responses provider for the WebChatProxy OpenAI-compatible facade.

## Runtime

- Provider id: `codex`
- Facade: `127.0.0.1:3250`
- Upstream: `https://chatgpt.com/backend-api/codex/responses`
- Credentials: `runtime/codex/auth.json`
- Concurrency: `1`

## HTTP contract

- `GET /health`
- `GET /v1/auth/codex/status`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/jobs`
- `GET /v1/jobs/{job_id}`

The local Codex facade does not expose ChatGPT project or conversation routes. Its Responses requests use `store: false`, so `conversation_id` is intentionally `null`.

## Codex Cloud resources

The authenticated Codex Cloud account exposes remote environments and tasks through the ChatGPT backend, separate from the local Responses facade:

- `GET /backend-api/wham/environments`
- `GET /backend-api/wham/tasks/list?environment_id={environment_id}`
- `GET /backend-api/wham/tasks/{task_id}`
- `POST /backend-api/wham/tasks`

An environment identifies the connected remote repository. The current API does not use `/backend-api/wham/projects`; project/repository discovery is represented by environments.

## Authentication

Use the OAuth login flow rather than copying tokens into source files:

```bash
sudo ops/root-login.sh --codex
sudo ops/root-provider-validate.sh
```

Live validation of `/v1/projects` and `/v1/conversations` on the local facade returns `404` by design. Codex Cloud environments/tasks are a separate capability and are not silently reported as local project support.
