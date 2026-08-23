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
