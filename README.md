# webchatproxy — WebChat Gateway

The **standalone Playwright browser automation gateway** for the WebChat system.

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐
│   webagent      │ HTTP│   webchatproxy       │
│   (Laravel)     │─────│   (this repo)        │
│                 │ :3210 Playwright + ChatGPT │
│ Auth/UI/Models  │     │ Browser automation   │
└─────────────────┘     └──────────────────────┘
```

The gateway runs a **headed Chromium instance** via Playwright to drive an interactive
ChatGPT session. It exposes a lightweight HTTP API that the Laravel web application
(`webagent`) and CLI tools consume.

Listening on: `http://127.0.0.1:3210`

## Filesystem Boundary (Production)

On production servers, this repo must be outside the document root:

```
/home/agent/
├── webchatproxy/     ← this repo (Node/Playwright core)
│   ├── server/
│   │   ├── browser-profile/  ← persistent session (never in webroot)
│   │   └── runtime/          ← jobs/logs/debug  (never in webroot)
├── webagent/
│   └── public_html/  ← Laravel web app (document root)
```

## Complementary Repository

The **Laravel web application** lives in [`1xLab/webagent`](https://github.com/1xLab/webagent).

## Quick Start

```bash
cd server
./start.sh start
./start.sh status
```
