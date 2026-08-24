#!/usr/bin/env bash
set -euo pipefail

ACCOUNT="${1:-}"
[[ "$ACCOUNT" =~ ^([0-9]|10)$ ]] || { echo "Usage: $0 <1-10>" >&2; exit 2; }
export HOME="${ANTIGRAVITY_HOME_ROOT:-/home/agent/.agy}/account-$ACCOUNT"
export PATH="/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
mkdir -p "$HOME"
exec /home/agent/.local/bin/agy
