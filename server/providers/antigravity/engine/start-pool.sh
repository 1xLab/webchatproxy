#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../.."
BASE_DIR="$(pwd -P)"
RUNTIME_DIR="${ANTIGRAVITY_POOL_RUNTIME_DIR:-$BASE_DIR/runtime/antigravity-pool}"
API_KEY_FILE="${ANTIGRAVITY_POOL_API_KEY_FILE:-$RUNTIME_DIR/.api-key}"

mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR"
if [ ! -s "$API_KEY_FILE" ]; then
  umask 077
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$API_KEY_FILE"
  printf '\n' >> "$API_KEY_FILE"
fi
chmod 600 "$API_KEY_FILE"
export ANTIGRAVITY_POOL_API_KEY_FILE="$API_KEY_FILE"
export ANTIGRAVITY_POOL_HOST="${ANTIGRAVITY_POOL_HOST:-127.0.0.1}"
export ANTIGRAVITY_POOL_PORT="${ANTIGRAVITY_POOL_PORT:-3240}"
exec node providers/antigravity/pool.mjs
