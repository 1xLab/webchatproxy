# GitHub integration

The WebChat admin UI connects to GitHub using a GitHub OAuth App. PHP performs the OAuth exchange, encrypts the token with AES-256-GCM and stores it in SQLite. GitHub credentials are never exposed to JavaScript.

## Required environment

```bash
WEBCHAT_ADMIN_PASSWORD_HASH='...'
WEBCHAT_GITHUB_CLIENT_ID=...
WEBCHAT_GITHUB_CLIENT_SECRET=...
WEBCHAT_GITHUB_CALLBACK_URL=https://example.com/github-oauth.php?action=callback
WEBCHAT_GITHUB_SCOPES="repo read:user read:org"
WEBCHAT_APP_KEY="long-random-secret"
WEBCHAT_DB_PATH=/home/ACCOUNT/data/webchat.sqlite
WEBCHAT_GATEWAY_URL=http://127.0.0.1:3210
WEBCHAT_GATEWAY_TOKEN="same-secret-used-by-WEBCHAT_API_TOKEN-on-the-gateway"
WEBCHAT_GITHUB_SYNC_SECONDS=30
WEBCHAT_GITHUB_REPO_SYNC_SECONDS=900
```

Generate the admin password hash without storing the plain password in the repository:

```bash
php -r 'echo password_hash("CHANGE-ME", PASSWORD_DEFAULT), PHP_EOL;'
```

`WEBCHAT_GITHUB_CALLBACK_URL` is mandatory and must be an absolute HTTPS URL. Dynamic callback construction is intentionally disabled because shared hosting and reverse proxies can report an internal scheme/host.

`WEBCHAT_GATEWAY_TOKEN` is the PHP-side name of the gateway Bearer secret. The Node gateway validates `WEBCHAT_API_TOKEN`; configure both with the same secret. PHP also accepts `WEBCHAT_API_TOKEN` as a fallback alias.

## Security

The admin panel requires a server-side PHP session. Mutating API requests require an `X-CSRF-Token` tied to that session. The UI sends the token automatically. CSP, frame denial, nosniff and same-origin referrer headers are emitted by PHP.

`WEBCHAT_APP_KEY`, OAuth Client Secret, OAuth access tokens, admin credentials and gateway tokens must remain outside the repository and outside the public document root.

## OAuth

After authenticating to WebChat Admin, use `Conectar GitHub via OAuth`. The flow uses authorization code, `state` and PKCE S256. The callback verifies the existing WebChat admin session before accepting the OAuth response.

## GitHub API resilience

The server-side GitHub client retries transient `429`, `403` rate-limit responses and `5xx` responses with bounded exponential backoff. `Retry-After` and `X-RateLimit-Reset` are honored when present.

## Cron

The cron is read-only with respect to GitHub. It only synchronizes repository/task state and stores events in SQLite.

Example cPanel cron, once per minute:

```bash
/usr/local/bin/php /home/ACCOUNT/public_html/cron/github-sync.php >> /home/ACCOUNT/logs/webchat-github-sync.log 2>&1
```

The script uses a local `flock` guard. The browser UI polls only PHP/SQLite; it never polls GitHub directly.

## Synced state

For linked tasks the application tracks Issue title/state/labels, latest Issue comment, linked PR, branch, HEAD SHA, commit status, derived task state and unseen events.

## Human review report

From the task strip, `Relatório` records status, summary, commit SHA, tests, logs/evidence and next action. Publishing to GitHub is explicit and goes to the linked PR when one exists, otherwise to the Issue.

## Human-in-loop

Cron never changes code, merges PRs, closes Issues or writes comments. GitHub writes are explicit administrator actions or explicitly authorized delegated AI jobs.

See `docs/HUMAN_IN_LOOP_GITHUB_WORKFLOW.md`.
