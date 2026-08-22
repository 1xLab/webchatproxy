# Upstream Research

This control-plane work was designed after reviewing existing ChatGPT Web automation projects instead of assuming the browser UI had to be rediscovered from scratch.

## ChatGPT-Web2API

Repository: `Octo-Lex/ChatGPT-Web2API`

License: MIT.

Useful validated concepts:

- authenticated browser session as the source of ChatGPT Web access;
- structured reads from ChatGPT `/backend-api/*` endpoints;
- Project discovery through `gizmos/snorlax/sidebar`;
- Project detail and file metadata;
- Project conversation listing;
- full historical conversation reads;
- explicit separation between ordinary backend reads and protected chat write flows.

`webchatproxy` does not vendor that project. The implementation in this repository is native Node.js and integrated with the existing `BrowserBackend`, runtime, diagnostics and job model.

## chatgpt-mcp

Repository: `parkermg/chatgpt-mcp`

Useful behavioral references:

- Playwright project selection/navigation;
- use of browser file inputs and `setInputFiles` for ChatGPT attachments;
- browser-side response completion observations.

The repository root reviewed during this work did not expose a license file and its package metadata did not declare a license. Therefore no source code from it is copied into `webchatproxy`; only observable architectural/behavioral ideas were used as research input.

## Why not install either project as a dependency

The existing proxy already owns:

- the persistent production `browser-profile`;
- lifecycle and Xvfb handling;
- job serialization and restart recovery;
- HTTP/auth contract;
- diagnostics/event journal;
- response capture;
- the fixed production runtime path `/home/agent/server`.

Replacing that runtime with a second browser automation stack would add profile contention and duplicate lifecycle logic. Reusing verified protocol knowledge and browser behaviors while keeping one browser owner is safer.

## Design result

The selected architecture is:

```text
                    +-------------------------+
                    | authenticated Chromium |
                    +------------+------------+
                                 |
                 +---------------+---------------+
                 |                               |
                 v                               v
        structured read page              interactive chat page
        GET /backend-api/*                Playwright UI actions
                 |                               |
       Projects/history/files             send/upload/navigation
```

The read page and chat page share the same persistent Playwright browser context/profile but serve different responsibilities. Resource reads do not need to navigate the active conversation page.

## Compatibility note

The ChatGPT Web backend endpoints and DOM selectors are undocumented implementation details and may change. They are intentionally isolated in:

```text
server/lib/chatgpt-control.mjs
server/browser-backend.mjs
```

Changes in ChatGPT should be repaired in those adapters rather than propagated into client APIs or application code.
