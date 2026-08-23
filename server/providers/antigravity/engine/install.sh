#!/usr/bin/env bash
set -euo pipefail
if command -v agy >/dev/null 2>&1; then
  agy --version
  exit 0
fi
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl is required" >&2; exit 78; }
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL https://antigravity.google/cli/install.sh -o "$tmp"
sh "$tmp"
AGY_BIN="$(command -v agy || true)"
if [ -z "$AGY_BIN" ] && [ -x "$HOME/.local/bin/agy" ]; then AGY_BIN="$HOME/.local/bin/agy"; fi
[ -n "$AGY_BIN" ] && [ -x "$AGY_BIN" ] || { echo "ERROR: agy installation completed but binary was not found" >&2; exit 78; }
"$AGY_BIN" --version
