# Kimi Web projects live validation

Run this only on the authenticated server after deploying the exact PR commit. Do not print `access_token`, `refresh_token` or `runtime/kimi/.api-key`.

## 1. Runtime and facade

```bash
cd /home/agent/webchatproxy
SHA="$(git rev-parse HEAD)"
echo "$SHA"
systemctl --no-pager --full status webchatproxy-kimi-runtime.service webchatproxy.service
ss -lntp | grep -E ':(3230|3330)\\b'
```

Required: Kimi runtime owns internal `3330`; universal gateway owns public facade `3230`.

## 2. Capabilities

```bash
curl -fsS http://127.0.0.1:3230/v1/providers | jq
```

Required Kimi facade capabilities:

```json
{
  "conversations": true,
  "projects": true,
  "project_conversations": true,
  "project_files": true
}
```

## 3. List real Kimi Web projects

```bash
curl -fsS http://127.0.0.1:3230/v1/projects | tee /tmp/kimi-projects.json | jq
```

The response must contain the real projects visible in the authenticated Kimi Web account. Record one project id without exposing any credential:

```bash
PROJECT_ID="$(jq -r '.. | objects | select(has("id")) | .id' /tmp/kimi-projects.json | head -n1)"
test -n "$PROJECT_ID" && test "$PROJECT_ID" != null
```

## 4. Project details, chats and files

```bash
curl -fsS "http://127.0.0.1:3230/v1/projects/$PROJECT_ID" | jq
curl -fsS "http://127.0.0.1:3230/v1/projects/$PROJECT_ID/conversations" | tee /tmp/kimi-project-chats.json | jq
curl -fsS "http://127.0.0.1:3230/v1/projects/$PROJECT_ID/files" | jq
```

Required: project detail returns the same project; project chats belong to that project; file listing returns HTTP 200.

## 5. Conversation and persisted messages

Select a real chat id from the project response:

```bash
CHAT_ID="$(jq -r '.. | objects | select(has("id")) | .id' /tmp/kimi-project-chats.json | head -n1)"
test -n "$CHAT_ID" && test "$CHAT_ID" != null
curl -fsS "http://127.0.0.1:3230/v1/conversations/$CHAT_ID" | jq
curl -fsS "http://127.0.0.1:3230/v1/conversations/$CHAT_ID/messages" | jq
```

Required: `GetChat` confirms the project relationship and `ListMessages` returns persisted Kimi Web history.

## 6. Universal gateway parity

The same resources must be reachable through `:3200` with routing-only `provider=kimi`:

```bash
curl -fsS 'http://127.0.0.1:3200/v1/projects?provider=kimi' | jq
curl -fsS "http://127.0.0.1:3200/v1/conversations?provider=kimi&project_id=$PROJECT_ID" | jq
```

Required: payloads match the Kimi facade semantically. `provider=kimi` must not be forwarded to Kimi Web itself.

## 7. Existing OpenAI-compatible chat regression

```bash
MODEL="$(curl -fsS http://127.0.0.1:3230/v1/models | jq -r '.data[0].id')"
curl -fsS \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg m "$MODEL" '{model:$m,messages:[{role:"user",content:"Reply exactly: KIMI_PROJECTS_OK"}]}')" \
  http://127.0.0.1:3230/v1/chat/completions | jq
```

Required: existing chat still succeeds after the project extension.

## 8. Token-refresh regression

Confirm the Kimi runtime is still using the existing access/refresh token lifecycle and no Moonshot API key was introduced. Observe one normal proactive refresh boundary when practical; do not disclose token contents.

## Evidence

Return:

- deployed commit SHA;
- HTTP status for each route above;
- project count and non-secret project names/ids as appropriate;
- confirmation that project chat `projectId` matches;
- confirmation that persisted messages were returned;
- OpenAI-compatible completion result marker;
- relevant service logs on failure.

Never return bearer tokens, refresh tokens, cookies or the local bridge API key.
