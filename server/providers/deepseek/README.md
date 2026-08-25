# DeepSeek provider

Independent DeepSeek Web provider for `webchatproxy`.

This provider is intentionally isolated from ChatGPT. It uses the reviewed MIT upstream `kittors/deepseek-web-api` pinned to commit `9b62d6a17ba502fa6aefa2dceb527d1e925aa6ce`.

Runtime isolation:

```text
HTTP      127.0.0.1:3220
Chrome CDP 127.0.0.1:9333
profile   server/browser-profile-deepseek/
data      server/runtime/deepseek/
vendor    server/.vendor/deepseek-web-api/
```

The provider does not share browser state, queue, process or port with ChatGPT.

Installation is explicit and never occurs during runtime startup:

```bash
cd server
./providers/deepseek/engine/install.sh
```

Authentication:

```bash
./providers/deepseek/engine/login.sh
```

Runtime:

```bash
./providers/deepseek/engine/start.sh
```

The installer fetches only the exact pinned upstream commit, verifies the resulting HEAD, installs the frozen pnpm lockfile, and runs typecheck, lint, tests and build before the provider can be started.

`start.sh` fails closed if the pinned engine has not already been installed and built.

## Facade and native capabilities

The WebChatProxy facade exposes only the provider chat contract:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`

The pinned native library does support conversation sessions. It persists session lineage in `DS_SESSION_FILE` and accepts `chat_session_id`, `conversation_id`, `previous_response_id`, or matching message history to continue a session. It does not define a project entity/API at the pinned upstream commit.

Therefore a facade `404` for `/v1/projects` is not evidence that the native session capability is absent; it means only that the proxy has not exposed a project route.
