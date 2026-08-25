#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
USER_NAME="${WEBCHAT_USER:-agent}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0" >&2
  exit 77
fi

cd "$ROOT"

echo "== prerequisites =="
node --version
go version
[ -x "${AGY_BIN:-/home/$USER_NAME/.local/bin/agy}" ]

echo "== source checks =="
su -s /bin/bash "$USER_NAME" -c "cd '$ROOT/server' && npm run check && npm test"

echo "== services =="
for unit in \
  webchatproxy.service \
  webchatproxy-antigravity-pool.service; do
  systemctl is-active --quiet "$unit"
  echo "$unit: active"
done

echo "== endpoints =="
for port in 3200 3230 3240 3250 3340; do
  curl --fail --silent --show-error "http://127.0.0.1:$port/health" >/tmp/webchatproxy-health-$port.json
  printf '%s: ' "$port"
  if command -v jq >/dev/null 2>&1; then
    jq -c '{ok,service,provider,port,available}' "/tmp/webchatproxy-health-$port.json"
  else
    cat "/tmp/webchatproxy-health-$port.json"
  fi
done

echo "== runtime material =="
for path in \
  "$ROOT/runtime" \
  "$ROOT/runtime/antigravity-pool/.api-key"; do
  if [ -e "$path" ]; then echo "present: $path"; else echo "missing: $path"; fi
done

echo "WebChatProxy validation passed."
