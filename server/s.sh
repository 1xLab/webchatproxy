#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:100}"
export HOME="${HOME:-/home/agent}"
export PATH="/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

if [ "$(id -un)" != "agent" ]; then
  echo "ERROR: run this script as agent, not $(id -un)." >&2
  exit 77
fi

exec /home/agent/.local/bin/agy "$@"
