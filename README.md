# WebChatProxy v3

One project, one execution core, four provider intelligence layers, and one authentication experience.

## Public API

All public inference calls pass through the same universal `JobManager`.

| Port | Meaning |
|---|---|
| `3200` | Universal OpenAI-compatible API. `provider` is supplied in the payload. |
| `3210` | ChatGPT facade. Injects `provider=chatgpt`. |
| `3220` | DeepSeek facade. Injects `provider=deepseek`. |
| `3230` | Kimi facade. Injects `provider=kimi`. |
| `3240` | Antigravity facade. Injects `provider=antigravity`. |

`model` always remains part of the OpenAI payload. A facade replaces only the provider selector. Extra provider parameters are preserved and forwarded after the JobManager handles control fields such as `request_id`, `async`, `timeout`, idempotency, queueing and cancellation.

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

## Usage metering

Every completed OpenAI-compatible response exposes `usage.prompt_tokens`, `usage.completion_tokens` and `usage.total_tokens`.

Provider-reported usage has priority. When a web provider does not report token statistics, the proxy produces an estimated count and identifies its provenance under `gateway.usage_measurement`. Consumers can therefore persist usage locally without depending on the proxy's own reporting API.

The proxy also maintains a central append-only ledger under `runtime/usage/` for provider/model/session/job reporting and later abuse-policy enforcement.

---

# Universal Provider Authentication

## Goal

Provider authentication must not require users or operators to establish SSH tunnels or operate a traditional VNC client.

The intended user experience is:

```text
WebAgent / browser
        |
        | Connect provider
        v
Universal Auth Manager
        |
        +-- browser-based auth --> temporary browser session --> Nginx/HTTPS
        |
        +-- CLI/token auth ------> provider-specific flow
        |
        v
persistent provider credential/session
        |
        v
provider runtime becomes available
```

Users should see provider-level actions such as **Connect ChatGPT**, **Connect DeepSeek**, **Connect Kimi** or **Manage Antigravity accounts**. They should not need to know about X11, Xvfb, x11vnc, noVNC, CDP, Chrome profile directories, systemd units or internal ports.

## Current browser-login implementation

The repository already contains the first browser-auth transport for ChatGPT:

```text
HTTPS / CWP / Nginx
        |
        v
127.0.0.1:6080 noVNC
        |
        v
127.0.0.1:5900 x11vnc
        |
        v
Xvfb :100
        |
        v
interactive Chrome
        |
        v
persistent ChatGPT browser profile
```

Relevant code lives under:

```text
server/browser-login/
server/cwp/
server/systemd/webchatproxy-browser-login.service
```

The browser-login service intentionally keeps VNC/noVNC on loopback and relies on the HTTPS reverse proxy for external access.

### Current setup

The current one-command setup is:

```bash
sudo /home/agent/webchatproxy/server/browser-login/setup-root.sh
```

It installs the browser-login systemd unit, CWP/Nginx templates and the HTTP authentication file, then starts the portal.

This is an interim transport. The target architecture below replaces permanent generic browser access with provider-scoped, temporary authentication sessions.

## Security correction required

The browser portal credential and the universal API credential must be separate security domains.

Do **not** use the same secret for both:

```text
WEBCHAT_UNIVERSAL_API_TOKEN   -> inference/API access only
BROWSER_PORTAL_TOKEN          -> browser-auth portal only
```

The current implementation reuses the universal token when building the Nginx Basic Auth credential. This is considered transitional and should be replaced by a dedicated browser-portal credential or, preferably, short-lived login-session tokens.

No API bearer token, provider token, refresh token, browser cookie or session secret may be embedded in a URL, committed to Git, or written to normal access logs.

## Target: Universal Auth Manager

Authentication becomes a first-class subsystem of WebChatProxy rather than a collection of manual provider commands.

Recommended structure:

```text
server/auth/
├── manager.mjs
├── browser/
│   └── session.mjs
└── providers/
    ├── chatgpt.mjs
    ├── deepseek.mjs
    ├── kimi.mjs
    └── antigravity.mjs
```

Minimal provider auth contract:

```js
{
  id: 'chatgpt',
  status(),
  startLogin(),
  finishLogin(),
  stopLogin(),
  logout()
}
```

A provider may implement only the mechanisms it needs. Browser-backed providers can use an interactive Chrome session. Token/CLI-backed providers can expose their native flow without pretending every provider requires VNC.

## Auth API

The WebAgent should interact only with a provider-neutral API:

```text
GET  /v1/auth/providers
GET  /v1/auth/:provider/status
POST /v1/auth/:provider/start
POST /v1/auth/:provider/stop
POST /v1/auth/:provider/logout
```

Example status:

```json
{
  "provider": "chatgpt",
  "status": "auth_required",
  "interactive_login": true
}
```

Example start result:

```json
{
  "provider": "chatgpt",
  "status": "login_pending",
  "login_url": "https://login.example.com/s/<opaque-token>",
  "expires_at": "2026-08-24T17:00:00Z"
}
```

The actual public host/domain is deployment configuration and must not be hard-coded into provider drivers.

## Temporary browser sessions

The preferred browser-login flow is a short-lived provider-scoped session rather than a permanently exposed noVNC desktop.

Recommended properties:

- cryptographically random opaque session token
- provider-bound
- single active browser-auth session per provider/profile
- short TTL, initially 10-15 minutes
- invalidated immediately after successful authentication or explicit stop
- no provider credentials stored in the session URL
- no public VNC/noVNC listener; Nginx remains the only external entry point
- session state persisted only as necessary for restart/recovery

Conceptual flow:

```text
POST /v1/auth/chatgpt/start
        |
        v
Auth Manager creates session
        |
        v
https://login.example.com/s/<temporary-token>
        |
        v
Nginx
        |
        v
noVNC / browser transport
        |
        v
interactive Chrome
```

After authentication:

```text
interactive Chrome closes
        |
login token invalidates
        |
provider runtime restarts
        |
health/auth verification runs
        |
status = authenticated
```

## Browser profile ownership is exclusive

The same Chrome `--user-data-dir` must not be written concurrently by the headless provider runtime and the interactive authentication browser.

For ChatGPT the Auth Manager must orchestrate:

```text
1. mark provider as auth_transition
2. stop/pause ChatGPT runtime
3. wait until Chrome/profile lock is released
4. start interactive Chrome with the persistent ChatGPT profile
5. expose that browser through the temporary login session
6. user completes authentication
7. detect or confirm successful login
8. close interactive Chrome
9. invalidate login session
10. restart headless ChatGPT runtime
11. verify provider health/authentication
12. return status=authenticated
```

The same exclusivity rule applies to any provider that shares a persistent browser profile between normal runtime and interactive authentication.

## Provider-specific auth behavior

### ChatGPT

- browser-backed authentication
- persistent ChatGPT Chrome profile
- runtime must be stopped while the interactive browser owns the profile
- after login, restart `3310` runtime and verify Web2API health/model discovery

### DeepSeek

- browser-backed authentication when required
- use its own persistent profile, never the ChatGPT profile
- restart/verify the internal `3320` runtime after authentication

### Kimi

- prefer native token/import/refresh behavior when available
- expose browser interaction only if the upstream flow actually requires it
- validate access/refresh state and restart/verify `3330`

### Antigravity

- auth is account-oriented rather than one global browser profile
- `/v1/auth/antigravity/status` should report pool/account state
- account-specific operations should identify account number/id without exposing credentials
- successful account authentication must feed the existing worker pool/cooldown/quota rotation

Example conceptual status:

```json
{
  "provider": "antigravity",
  "status": "partial",
  "accounts": {
    "configured": 10,
    "authenticated": 7,
    "available": 6,
    "cooldown": 1
  }
}
```

## Authentication state model

Use explicit states so the WebAgent does not infer auth from HTTP errors:

```text
unknown
authenticated
auth_required
login_starting
login_pending
verifying
auth_transition
failed
```

Provider status should also include a machine-readable reason when possible, for example `token_expired`, `browser_session_expired`, `profile_locked`, `quota_exhausted`, `oauth_required` or `runtime_unavailable`.

## noVNC dependency

The current installer clones the latest noVNC branch. This should be replaced with a pinned release or commit, consistent with the repository's policy of pinning important upstream runtime dependencies.

The Auth Manager should treat noVNC as browser transport only. Provider authentication lifecycle belongs to WebChatProxy, not to noVNC.

## Immediate implementation plan

The next implementation should be deliberately small:

1. Add `server/auth/manager.mjs` and provider adapter contract.
2. Implement ChatGPT first using the existing browser-login scripts as the transport.
3. Separate `BROWSER_PORTAL_TOKEN` from `WEBCHAT_UNIVERSAL_API_TOKEN` immediately.
4. Add `/v1/auth/providers`, `/v1/auth/:provider/status`, `/v1/auth/:provider/start` and `/v1/auth/:provider/stop`.
5. Enforce exclusive ownership of the ChatGPT browser profile.
6. Return a temporary login session URL instead of exposing a permanent generic browser desktop.
7. Restart and health-check the provider runtime automatically after login.
8. Move DeepSeek into the same contract.
9. Expose Kimi token status/refresh under the same auth API.
10. Expose Antigravity pool/account authentication status under the same auth API.
11. Pin the noVNC upstream version/commit.
12. Add deterministic tests for state transitions, expiry, token separation, provider isolation and profile locking.
13. Add server-side live validation for Nginx/WebSocket/login/restart behavior.

The MVP is complete when a WebAgent can discover auth state, request a login, open the returned temporary URL, complete authentication and observe the provider become healthy without SSH or a VNC client.

## Fresh server install

Copy the repository to `/home/agent/webchatproxy`, then run:

```bash
sudo /home/agent/webchatproxy/deploy.sh
```

The deployment script builds the pinned provider runtimes, installs systemd units, starts available providers and starts the universal gateway. Providers that still require interactive login/token import remain unavailable until their credentials are provisioned; this does not prevent the core gateway from starting.

Current provider credential commands from `/home/agent/webchatproxy/server` remain available while the Universal Auth Manager is being implemented:

```bash
npm run deepseek:login
npm run kimi:import-token
npm run antigravity:login-account -- 1
```

For Antigravity accounts, repeat the account login for the desired account numbers before enabling the corresponding `webchatproxy-antigravity@N.service` units.

## Development rule

All authentication work must preserve the existing universal execution architecture:

```text
many public entrypoints
        |
        v
one universal JobManager
        |
        v
provider adapters/runtimes
```

The Auth Manager is a parallel control plane. It prepares and verifies provider credentials/sessions; it does not create a second inference execution path.
