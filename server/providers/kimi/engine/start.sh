#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../.."
BASE_DIR="$(pwd -P)"
LOCK_FILE="$BASE_DIR/providers/kimi/engine/UPSTREAM.lock"
VENDOR_DIR="${KIMI_VENDOR_DIR:-$BASE_DIR/.vendor/kimi-free-api}"
BIN="$VENDOR_DIR/kimi-proxy"
RUNTIME_DIR="${KIMI_RUNTIME_DIR:-$BASE_DIR/runtime/kimi}"
TOKEN_FILE="${KIMI_TOKEN_FILE:-$RUNTIME_DIR/access_token}"
API_KEY_FILE="${KIMI_API_KEY_FILE:-$RUNTIME_DIR/.api-key}"
PIN="$(awk -F= '$1=="commit"{print $2}' "$LOCK_FILE")"

[ -x "$BIN" ] || { echo "ERROR: Kimi engine not installed. Run providers/kimi/engine/install.sh" >&2; exit 78; }
[ -d "$VENDOR_DIR/.git" ] || { echo "ERROR: Kimi vendor checkout metadata missing" >&2; exit 78; }
test "$(git -C "$VENDOR_DIR" rev-parse HEAD)" = "$PIN" || { echo "ERROR: Kimi vendor checkout is not at pinned commit $PIN" >&2; exit 78; }
[ -s "$TOKEN_FILE" ] || { echo "ERROR: missing Kimi access token: $TOKEN_FILE. Run providers/kimi/engine/import-token.sh" >&2; exit 78; }

mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR"

if [ ! -s "$API_KEY_FILE" ]; then
  umask 077
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$API_KEY_FILE"
  printf '\n' >> "$API_KEY_FILE"
fi
chmod 600 "$TOKEN_FILE" "$API_KEY_FILE"

export HOST="${KIMI_HOST:-127.0.0.1}"
export PORT="${KIMI_PORT:-3230}"
export KIMI_ACCESS_TOKEN="$(head -n1 "$TOKEN_FILE")"
export AUTH_KEY="$(head -n1 "$API_KEY_FILE")"

[ -n "$KIMI_ACCESS_TOKEN" ] || { echo "ERROR: Kimi access token is empty" >&2; exit 78; }
[ -n "$AUTH_KEY" ] || { echo "ERROR: Kimi API key is empty" >&2; exit 78; }

exec "$BIN"
