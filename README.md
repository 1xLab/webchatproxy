# WebChatProxy v3

One project, one execution core, four provider intelligence layers.

## Public API

All public calls pass through the same `JobManager`.

| Port | Meaning |
|---|---|
| `3200` | Universal OpenAI-compatible API. `provider` is supplied in the payload. |
| `3210` | ChatGPT facade. Injects `provider=chatgpt`. |
| `3220` | DeepSeek facade. Injects `provider=deepseek`. |
| `3230` | Kimi facade. Injects `provider=kimi`. |
| `3240` | Antigravity facade. Injects `provider=antigravity`. |

`model` always remains part of the OpenAI payload. The facade replaces only the provider selector. Extra provider parameters are preserved and forwarded after the JobManager handles control fields such as `request_id`, `async`, `timeout`, idempotency, queueing and cancellation.

## Internal runtimes

These ports are loopback-only implementation details:

| Port | Runtime |
|---|---|
| `3310` | ChatGPT Web2API runtime |
| `3320` | DeepSeek web runtime |
| `3330` | Kimi runtime with token refresh |
| `3340` | Antigravity account pool |
| `3251-3260` | Antigravity account workers 1-10 |

The public facades never call each other. They resolve through the `ProviderRegistry` to the corresponding internal runtime, so there is no port recursion.

## Provider intelligence retained

- **ChatGPT:** pinned Web2API bridge, browser/CDP ownership, conversations, projects/model discovery and persistent browser profile. The provider-specific JobManager is not used for execution; the v3 universal JobManager owns jobs.
- **DeepSeek:** pinned upstream checkout, patch layer, persistent auth/session files, browser login and CDP runtime.
- **Kimi:** pinned upstream checkout, access/refresh token runtime, proactive background refresh and on-demand refresh barrier.
- **Antigravity:** `agy` CLI integration, per-account homes/sessions, ten-account worker pool, account health/cooldown and quota-exhaustion rotation.

## Request examples

Universal endpoint:

```json
{
  "provider": "kimi",
  "model": "k2d6",
  "messages": [{"role":"user","content":"hello"}],
  "conversation_id": null,
  "temperature": 0.5
}
```

Kimi facade (`http://127.0.0.1:3230/v1/chat/completions`):

```json
{
  "model": "k2d6",
  "messages": [{"role":"user","content":"hello"}],
  "temperature": 0.5
}
```

Both requests go through the same JobManager. The second request simply gets `provider=kimi` injected by the listening port.

## Core responsibilities

The universal JobManager owns:

- job ids and request idempotency
- provider/model routing
- per-provider concurrency and queues
- `conversation_id` transport
- timeout and cancellation
- atomic job persistence
- restart recovery as `interrupted`
- result/usage normalization
- sync, async and OpenAI-compatible SSE responses

Provider adapters own authentication/session mechanics and provider-specific protocol details only.

## Fresh server install

Copy the repository to `/home/agent/webchatproxy`, then run:

```bash
sudo /home/agent/webchatproxy/deploy.sh
```

The deployment script builds the pinned provider runtimes, installs systemd units, starts available providers and starts the universal gateway. Providers that still require interactive login/token import remain unavailable until their credentials are provisioned; this does not prevent the core gateway from starting.

Useful credential commands from `/home/agent/webchatproxy/server`:

```bash
npm run deepseek:login
npm run kimi:import-token
npm run antigravity:login-account -- 1
```

For Antigravity accounts, repeat the account login for the desired account numbers before enabling the corresponding `webchatproxy-antigravity@N.service` units.
