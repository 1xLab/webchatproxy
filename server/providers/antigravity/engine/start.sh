#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
BASE_DIR="$(pwd -P)"
RUNTIME_DIR="${ANTIGRAVITY_RUNTIME_DIR:-$BASE_DIR/runtime/antigravity}"
API_KEY_FILE="${ANTIGRAVITY_API_KEY_FILE:-$RUNTIME_DIR/.api-key}"
CONTEXT_DIR="${ANTIGRAVITY_CONTEXT_DIR:-$RUNTIME_DIR/context}"
AGY_BIN="${AGY_BIN:-$(command -v agy || true)}"

[ -n "$AGY_BIN" ] && [ -x "$AGY_BIN" ] || { echo "ERROR: agy CLI not installed; run providers/antigravity/engine/install.sh" >&2; exit 78; }
mkdir -p "$RUNTIME_DIR"
mkdir -p "$CONTEXT_DIR"
chmod 700 "$RUNTIME_DIR"
chmod 700 "$CONTEXT_DIR"
if [ ! -s "$API_KEY_FILE" ]; then
  umask 077
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$API_KEY_FILE"
  printf '\n' >> "$API_KEY_FILE"
fi
chmod 600 "$API_KEY_FILE"
export AGY_BIN
export ANTIGRAVITY_API_KEY_FILE="$API_KEY_FILE"
export ANTIGRAVITY_CONTEXT_DIR="$CONTEXT_DIR"
export ANTIGRAVITY_HOST="${ANTIGRAVITY_HOST:-127.0.0.1}"
if [[ "${ANTIGRAVITY_INSTANCE:-}" =~ ^[1-9][0-9]*$ ]]; then
  export ANTIGRAVITY_PORT="$((3250 + ANTIGRAVITY_INSTANCE))"
else
  export ANTIGRAVITY_PORT="${ANTIGRAVITY_PORT:-3240}"
fi
exec node providers/antigravity/server.mjs
