#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../.."
BASE_DIR="$(pwd -P)"
DEPLOY_ROOT="$(cd "$BASE_DIR/.." && pwd -P)"
LOCK_FILE="$BASE_DIR/providers/deepseek/engine/UPSTREAM.lock"
VENDOR_DIR="${DEEPSEEK_VENDOR_DIR:-$BASE_DIR/.vendor/deepseek-web-api}"
PIN="$(awk -F= '$1=="commit"{print $2}' "$LOCK_FILE")"
ENTRY="$VENDOR_DIR/dist/index.js"

[ -f "$ENTRY" ] || { echo "ERROR: DeepSeek engine is not installed/built. Run providers/deepseek/engine/install.sh" >&2; exit 78; }
test "$(git -C "$VENDOR_DIR" rev-parse HEAD)" = "$PIN" || { echo "ERROR: DeepSeek vendor checkout is not at pinned commit $PIN" >&2; exit 78; }

export HOST="127.0.0.1"
export PORT="${DEEPSEEK_PORT:-3220}"
export DS_CDP="${DS_CDP:-http://127.0.0.1:9333}"
export DS_DATA_DIR="${DS_DATA_DIR:-$DEPLOY_ROOT/runtime/deepseek}"
export DS_AUTH_FILE="${DS_AUTH_FILE:-$DS_DATA_DIR/auth.json}"
export DS_SESSION_FILE="${DS_SESSION_FILE:-$DS_DATA_DIR/sessions.json}"
export DS_CHROME_PROFILE="${DS_CHROME_PROFILE:-$DEPLOY_ROOT/browser-profile-deepseek}"
export DS_SHOW_BROWSER=1

mkdir -p "$DS_DATA_DIR" "$DS_CHROME_PROFILE"
exec node "$ENTRY" login
