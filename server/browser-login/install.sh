#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
DEST="${BROWSER_LOGIN_NOVNC_DIR:-$ROOT/runtime/noVNC}"
mkdir -p "$(dirname "$DEST")"

if [ ! -x "$DEST/utils/novnc_proxy" ]; then
  rm -rf "$DEST"
  git clone --depth 1 https://github.com/novnc/noVNC.git "$DEST"
fi

test -x "$DEST/utils/novnc_proxy"
printf 'noVNC ready: %s\n' "$DEST"
