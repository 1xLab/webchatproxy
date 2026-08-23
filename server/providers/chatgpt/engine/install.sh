#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../.."
BASE_DIR="$(pwd -P)"
ENGINE_DIR="$BASE_DIR/providers/chatgpt/engine"
VENV="${WEBCHAT_ENGINE_VENV:-$BASE_DIR/.venv-chatgpt}"
REQUIREMENTS="$ENGINE_DIR/requirements.txt"

select_python() {
  if [ -n "${WEBCHAT_ENGINE_BOOTSTRAP_PYTHON:-}" ]; then
    printf '%s\n' "$WEBCHAT_ENGINE_BOOTSTRAP_PYTHON"
    return
  fi
  local candidate
  for candidate in python3.13 python3.12 python3.11 python3; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if sys.version_info >= (3, 11) else 1)
PY
    then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
}

PYTHON_BOOTSTRAP="$(select_python || true)"
if [ -z "$PYTHON_BOOTSTRAP" ]; then
  echo "ERROR: ChatGPT-Web2API requires Python 3.11+. Install python3.11+ or set WEBCHAT_ENGINE_BOOTSTRAP_PYTHON." >&2
  exit 78
fi

if [ ! -f "$REQUIREMENTS" ]; then
  echo "ERROR: missing provider requirements: $REQUIREMENTS" >&2
  exit 78
fi

if [ ! -x "$VENV/bin/python" ]; then
  "$PYTHON_BOOTSTRAP" -m venv "$VENV"
fi

"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install -r "$REQUIREMENTS"
"$VENV/bin/python" - <<'PY'
import chatgpt_web2api
import sys
print(f"ChatGPT-Web2API import OK on Python {sys.version.split()[0]}")
PY

printf 'ChatGPT engine Python: %s\n' "$VENV/bin/python"
printf 'Pinned requirements: %s\n' "$REQUIREMENTS"
