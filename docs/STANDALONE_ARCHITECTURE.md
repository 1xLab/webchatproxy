# webchatproxy Standalone Architecture

## Scope

The canonical repository is `1xLab/webchatproxy`.

The product consists of the Node.js gateway, Playwright browser automation, persistent browser profile, local runtime state, diagnostics and deployment assets required to operate the gateway.

## Process

Default listener:

```text
127.0.0.1:3210
```

Main configuration:

```bash
WEBCHAT_HOST=127.0.0.1
WEBCHAT_PORT=3210
WEBCHAT_PROFILE_DIR=/path/to/browser-profile
WEBCHAT_RUNTIME_DIR=/path/to/runtime
WEBCHAT_API_TOKEN=secret
```

## Runtime layout

Recommended deployment layout:

```text
webchatproxy/
└── server/
    ├── bootstrap.mjs
    ├── standalone.mjs
    ├── browser-backend.mjs
    ├── browser-auth.mjs
    ├── doctor.mjs
    ├── start.sh
    ├── remote_ia.sh
    ├── lib/
    ├── tests/
    ├── browser-profile/   # local persistent session, ignored by Git
    └── runtime/           # local jobs/logs/debug, ignored by Git
```

## Request flow

```text
HTTP client
    |
    v
Gateway API
    |
    v
JobManager
    |
    v
BrowserBackend
    |
    v
Playwright persistent browser context
    |
    v
ChatGPT Web
```

## Job contract

The asynchronous endpoint is:

```http
POST /v1/jobs
```

Example:

```json
{
  "request_id": "client-123:message-456",
  "model": "chatgpt-web",
  "messages": [
    {"role": "user", "content": "Hello"}
  ],
  "conversation_id": null,
  "new_conversation": true,
  "timeout": 210000
}
```

The OpenAI-compatible synchronous endpoint is:

```http
POST /v1/chat/completions
```

It can also return an asynchronous job when requested through `Prefer: respond-async` or `{"async": true}`.

## Persistence

Jobs are persisted under:

```text
server/runtime/jobs/{job-id}.json
```

Runtime persistence exists for observability and restart recovery. It is not a client integration mechanism.

## Browser profile ownership

The persistent browser profile is the authentication boundary for ChatGPT Web. It must not be copied into source control or opened concurrently by multiple browser processes.

Authentication is performed with:

```bash
./start.sh browser-auth
```

## Scaling model

The unit of concurrency is a browser worker/profile, not a shared Playwright page.

```text
Gateway/Scheduler
      |
  +---+---+
  |       |
Worker A  Worker B
Profile A Profile B
Chrome A  Chrome B
```

Each worker must have independent profile, queue, browser context, runtime state, health and restart lifecycle.

## Security

- loopback bind by default;
- Bearer authentication available through `WEBCHAT_API_TOKEN`;
- CORS disabled unless explicitly configured;
- profile and runtime ignored by Git;
- debug endpoints must not expose cookies, localStorage, session tokens or other browser credentials.

## Diagnostics

See `DEBUG_CONTRACT.md`.
