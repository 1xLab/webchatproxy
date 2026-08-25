#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../.."
BASE_DIR="$(pwd -P)"
DEPLOY_ROOT="$(cd "$BASE_DIR/.." && pwd -P)"
RUNTIME_DIR="${KIMI_RUNTIME_DIR:-$DEPLOY_ROOT/runtime/kimi}"
TOKEN_FILE="${KIMI_TOKEN_FILE:-$RUNTIME_DIR/access_token}"

mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR"
umask 077

if [ -n "${KIMI_ACCESS_TOKEN:-}" ]; then
  token="$KIMI_ACCESS_TOKEN"
elif [ -t 0 ]; then
  printf 'Kimi access_token: ' >&2
  IFS= read -r -s token
  printf '\n' >&2
else
  IFS= read -r token
fi

[ -n "${token:-}" ] || { echo "ERROR: empty Kimi access token" >&2; exit 64; }
printf '%s\n' "$token" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
printf 'Kimi access token written to %s\n' "$TOKEN_FILE"
