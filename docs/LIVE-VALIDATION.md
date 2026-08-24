# WebChatProxy live validation handoff

This document is the server-side validation contract for the unified WebChatProxy architecture.

GitHub Actions can validate syntax, unit behavior, integration behavior, architecture, provider wiring and port contracts without secrets. It cannot prove browser/OAuth/session state on the production host. The operator with server access must complete the checks below after syncing the repository.

## Expected topology

Public/OpenAI-compatible entrypoints:

- `127.0.0.1:3200` universal gateway; request must include `provider` and `model`.
- `127.0.0.1:3210` ChatGPT facade; injects `provider=chatgpt`, request still includes `model`.
- `127.0.0.1:3220` DeepSeek facade; injects `provider=deepseek`, request still includes `model`.
- `127.0.0.1:3230` Kimi facade; injects `provider=kimi`, request still includes `model`.
- `127.0.0.1:3240` Antigravity facade; injects `provider=antigravity`, request still includes `model`.

Internal runtimes:

- `3310` ChatGPT runtime
- `3320` DeepSeek runtime
- `3330` Kimi runtime
- `3340` Antigravity pool
- `3251..3260` Antigravity account workers

Every request on `3200..3240` must pass through the same universal JobManager.

## 1. Before destructive replacement

If this deployment is intentionally a full reset, remove the previous application only after deciding whether authentication state must be preserved. Browser profiles, Kimi tokens and Antigravity account homes are credential/session material, not source code.

Confirm the checked-out commit first:

```bash
git rev-parse HEAD
```

Run the deterministic suite on the exact checkout:

```bash
cd /home/agent/webchatproxy/server
npm run check
npm test
```

Both commands must exit `0` before installation.

## 2. Install the single project

From the project root:

```bash
cd /home/agent/webchatproxy
sudo ./deploy.sh
```

The deploy script installs/builds pinned provider runtimes, installs the systemd units and starts the universal gateway. Providers without valid login/token material are allowed to remain unavailable until authenticated.

## 3. Verify systemd and port ownership

```bash
systemctl --no-pager --full status webchatproxy.service
systemctl --no-pager --full status webchatproxy-chatgpt-runtime.service
systemctl --no-pager --full status webchatproxy-deepseek-runtime.service
systemctl --no-pager --full status webchatproxy-kimi-runtime.service
systemctl --no-pager --full status webchatproxy-antigravity-pool.service
ss -lntp | grep -E ':(3200|3210|3220|3230|3240|3310|3320|3330|3340|325[1-9]|3260)\\b'
```

Required invariants:

1. `3200..3240` belong to the universal gateway process, not to provider engines.
2. `3310..3340` belong only to internal provider runtimes/pool.
3. No old service is listening on `3210..3240`.
4. The gateway can remain active even when an individual provider runtime is not authenticated.

## 4. Universal gateway contract

```bash
curl -fsS http://127.0.0.1:3200/health | jq
curl -fsS http://127.0.0.1:3200/v1/providers | jq
```

Expected providers: `chatgpt`, `deepseek`, `kimi`, `antigravity`.

If `WEBCHAT_UNIVERSAL_API_TOKEN` is configured, add `Authorization: Bearer ...` without printing the token into logs.

## 5. Facade contract

For each facade, `/v1/models` must resolve the fixed provider without a `provider` query parameter:

```bash
curl -fsS http://127.0.0.1:3210/v1/models | jq
curl -fsS http://127.0.0.1:3220/v1/models | jq
curl -fsS http://127.0.0.1:3230/v1/models | jq
curl -fsS http://127.0.0.1:3240/v1/models | jq
```

A conflicting provider must be rejected. Example:

```bash
curl -sS -o /tmp/provider-mismatch.json -w '%{http_code}\n' \
  -H 'Content-Type: application/json' \
  -d '{"provider":"kimi","model":"x","messages":[{"role":"user","content":"x"}]}' \
  http://127.0.0.1:3220/v1/chat/completions
cat /tmp/provider-mismatch.json | jq
```

Expected HTTP status: `400`, code `provider_port_mismatch`.

## 6. Live provider smoke tests

Do not hard-code model names. Discover a model from each facade and use the returned model id.

Example helper for DeepSeek:

```bash
MODEL="$(curl -fsS http://127.0.0.1:3220/v1/models | jq -r '.data[0].id')"
curl -fsS \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg m "$MODEL" '{model:$m,messages:[{role:"user",content:"Reply exactly: DEEPSEEK_OK"}]}')" \
  http://127.0.0.1:3220/v1/chat/completions | jq
```

Repeat on ports `3210`, `3230`, and `3240`, changing only the expected marker. Verify:

- response is OpenAI-compatible;
- `gateway.provider` matches the facade;
- returned `model` matches the selected model or the provider-normalized model;
- `gateway.job_id` exists;
- `gateway.status` is `completed`;
- provider answer reaches the caller.

## 7. Universal-route smoke tests

For the same model discovered from a facade, call port `3200` with explicit `provider`:

```bash
curl -fsS \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg p deepseek --arg m "$MODEL" '{provider:$p,model:$m,messages:[{role:"user",content:"Reply exactly: UNIVERSAL_OK"}]}')" \
  http://127.0.0.1:3200/v1/chat/completions | jq
```

The result must traverse the same JobManager and return `gateway.provider=deepseek`.

## 8. JobManager live behavior

Create an asynchronous job:

```bash
curl -fsS \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: live-idempotency-1' \
  -d "$(jq -nc --arg p deepseek --arg m "$MODEL" '{provider:$p,model:$m,async:true,messages:[{role:"user",content:"Reply exactly: JOB_OK"}]}')" \
  http://127.0.0.1:3200/v1/jobs | tee /tmp/webchat-job.json | jq
```

Read the returned job id and poll it:

```bash
JOB_ID="$(jq -r '.job.id' /tmp/webchat-job.json)"
curl -fsS "http://127.0.0.1:3200/v1/jobs/$JOB_ID" | jq
```

Repeat the exact POST with the same idempotency key. It must return the same job with `reused=true`. Change the payload while keeping the same idempotency key; it must return HTTP `409`.

## 9. Conversation isolation

For providers that expose native conversation ids:

1. Start conversation A without a `conversation_id` and record the returned `gateway.conversation_id`.
2. Start conversation B separately and record its id.
3. Continue A by sending A's id.
4. Continue B by sending B's id.
5. Verify the two contexts remain isolated.

For ChatGPT, also verify conversation/project discovery against the restored Web2API layer. For Antigravity, verify the returned AGY conversation id is not replaced by process-global state.

## 10. Provider-specific intelligence

### ChatGPT

Verify persistent browser/Web2API authentication, model discovery, conversation continuation and project/conversation operations. Restart the ChatGPT runtime and confirm authenticated browser state survives when its profile is intentionally preserved.

### DeepSeek

Verify the pinned vendor commit, installed patch, browser/login state, session persistence and OpenAI-compatible chat through internal port `3320` and facade `3220`.

### Kimi

Verify access token presence, startup, one successful completion, then observe proactive refresh behavior. Confirm the refresh layer can update access credentials without requiring a chat request and that an on-demand refresh still protects a request near expiry.

### Antigravity

Verify the pool on `3340`, account workers on `3251..3260`, available account count, model aggregation, successful chat and quota failover. A quota/rate-limit response from the active account must place it on cooldown and route a subsequent eligible request to another available account.

## 11. Restart/recovery test

After at least one successful job per provider:

```bash
sudo systemctl restart webchatproxy.service
curl -fsS http://127.0.0.1:3200/health | jq
```

Verify persisted completed jobs remain readable. A job that was non-terminal during an actual gateway interruption must not silently become `completed`; recovery should expose it as interrupted/failed according to the JobManager contract.

## 12. Evidence to return to the coding agent

Return one report containing:

- exact commit SHA deployed;
- `npm run check` result;
- `npm test` result and test count;
- `systemctl` state for all six main units;
- listening ports/processes;
- `/health` output from `3200`;
- `/v1/providers` output;
- `/v1/models` success/failure for each facade;
- one completion result per available provider;
- idempotency test result;
- conversation-isolation result where supported;
- Kimi refresh observation;
- Antigravity pool/failover observation;
- relevant journal excerpts for any failure.

Do not return passwords, bearer tokens, refresh tokens, browser cookies or API keys.

A provider that is not authenticated should be reported as `AUTH_REQUIRED`, not hidden and not treated as a gateway architecture failure.
