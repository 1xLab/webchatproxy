#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
NOVNC_DIR="${BROWSER_LOGIN_NOVNC_DIR:-$ROOT/runtime/noVNC}"
DISPLAY_NUM="${BROWSER_LOGIN_DISPLAY:-100}"
VNC_PORT="${BROWSER_LOGIN_VNC_PORT:-5900}"
WEB_PORT="${BROWSER_LOGIN_WEB_PORT:-6080}"
PROFILE="${BROWSER_LOGIN_PROFILE:-$ROOT/browser-profile}"
export DISPLAY=":$DISPLAY_NUM"
export HOME="${HOME:-/home/agent}"

mkdir -p "$ROOT/runtime/browser-login" "$PROFILE"
cleanup() {
  jobs -pr | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT INT TERM

Xvfb "$DISPLAY" -screen 0 1920x1080x24 -ac -nolisten tcp &
sleep 1
x11vnc -display "$DISPLAY" -localhost -rfbport "$VNC_PORT" -forever -shared -nopw -noxdamage &
"$NOVNC_DIR/utils/novnc_proxy" --listen "$WEB_PORT" --vnc "127.0.0.1:$VNC_PORT" --web "$NOVNC_DIR" &
google-chrome \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --no-first-run \
  --no-default-browser-check \
  https://chatgpt.com &

wait -n
