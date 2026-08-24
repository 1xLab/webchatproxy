#!/usr/bin/env bash
set -euo pipefail
AGY_BIN="${AGY_BIN:-$(command -v agy || true)}"
[ -n "$AGY_BIN" ] && [ -x "$AGY_BIN" ] || { echo "ERROR: agy CLI not installed" >&2; exit 78; }
exec "$AGY_BIN"
