#!/usr/bin/env bash
set -euo pipefail

ROOT="${WEBCHAT_ROOT:-/home/agent/webchatproxy}"
KEY="$(sed -n 's/^WEBCHAT_UNIVERSAL_API_TOKEN=//p' "$ROOT/runtime/webchatproxy.env")"
AUTH="$(curl -fsS -H "Authorization: Bearer $KEY" http://127.0.0.1:3250/v1/auth/codex/start)"
URL="$(printf '%s' "$AUTH" | python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])')"

if [ -z "$URL" ]; then
  echo "Codex OAuth URL was not returned" >&2
  exit 1
fi

ENCODED="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$URL")"
curl -fsS -X PUT "http://127.0.0.1:9222/json/new?${ENCODED}" >/dev/null
echo "Codex OAuth opened in the remote browser. Complete login through the browser portal."
