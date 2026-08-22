# Upstream Engine Decision

`webchatproxy` is an API-only proxy core. It does not provide a user interface and it does not depend on `webagent`, Laravel or `/api/chat/*` routes.

## Selected engine: ChatGPT-Web2API

Repository: `Octo-Lex/ChatGPT-Web2API`

License: MIT.

Runtime dependency is pinned to the reviewed upstream commit:

```text
497527dceabfa3f95961e23c291e618c5570f1ac
```

The pin is declared in `server/requirements-engine.txt` so ChatGPT Web drift or upstream changes are explicit and reproducible.

The upstream engine owns the normal browser/CDP runtime and provides the mature implementation for:

- ChatGPT session/token lifecycle;
- Chrome/CDP ownership;
- model discovery and model selection;
- Project discovery;
- conversation listing and history retrieval;
- Project file metadata reads;
- Project-aware and conversation-aware chat;
- browser locking, retry, rate-limit handling, breakers and diagnostics.

`webchatproxy` no longer maintains its own JavaScript implementation of ChatGPT `/backend-api/*` reads. The former `server/lib/chatgpt-control.mjs` implementation was removed.

## Product boundary

The public product remains the Node HTTP facade on port 3210:

```text
API consumer
    |
    v
webchatproxy :3210
    |  auth / jobs / aliases / uploads / diagnostics
    v
Web2ApiEngine
    |
    v
loopback Python bridge :3211
    |
    v
pinned ChatGPT-Web2API
    |
    v
Chrome/CDP + canonical browser-profile
    |
    v
chatgpt.com
```

The Python bridge is an internal implementation detail and binds to loopback only. MCP is not part of the public product surface.

The canonical production paths remain:

```text
/home/agent/server
/home/agent/server/browser-profile
/home/agent/server/runtime
```

## Why this replaced the custom control plane

A custom Node control-plane request to the undocumented ChatGPT Project sidebar API returned HTTP 422 during live testing. Maintaining a second reverse-engineered backend client duplicated work already handled by a more mature MIT-licensed implementation.

The replacement deliberately centralizes ChatGPT Web drift in the upstream engine instead of duplicating endpoint payloads, token handling, CDP lifecycle and retry behavior in this repository.

## chatgpt-mcp research

Repository: `parkermg/chatgpt-mcp`.

It was reviewed only as a behavioral reference for browser automation and attachment workflows. It is not a dependency and no source from it is vendored into `webchatproxy`.

## Current capability boundary

The pinned ChatGPT-Web2API engine supports the core API paths used for models, Projects, conversations, Project file metadata and chat.

Local binary staging through `/v1/files` remains available in `webchatproxy`, but the pinned upstream engine does not expose a safe per-message attachment operation. Therefore a chat request containing staged `attachments` currently fails closed with HTTP 501 instead of silently sending the prompt without its document.

Likewise, `reasoning_effort` fails closed with HTTP 501 until the selected upstream engine implements that control.

Persistent Project knowledge-file mutation is also not claimed as implemented.
