#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
BASE_DIR="$(pwd -P)"
VENV="${WEBCHAT_ENGINE_VENV:-$BASE_DIR/.venv-engine}"
PYTHON_BOOTSTRAP="${WEBCHAT_ENGINE_BOOTSTRAP_PYTHON:-python3}"
REQUIREMENTS="$BASE_DIR/requirements-engine.txt"

command -v "$PYTHON_BOOTSTRAP" >/dev/null 2>&1 || {
  echo "ERROR: Python 3.11+ is required for ChatGPT-Web2API." >&2
  exit 78
}

"$PYTHON_BOOTSTRAP" - <<'PY'
import sys
if sys.version_info < (3, 11):
    raise SystemExit(f"ERROR: Python 3.11+ required; found {sys.version.split()[0]}")
PY

if [ ! -x "$VENV/bin/python" ]; then
  "$PYTHON_BOOTSTRAP" -m venv "$VENV"
fi

"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install -r "$REQUIREMENTS"
"$VENV/bin/python" - <<'PY'
import chatgpt_web2api
print("ChatGPT-Web2API engine import OK")
PY

printf 'Engine Python: %s\n' "$VENV/bin/python"
printf 'Pinned requirements: %s\n' "$REQUIREMENTS"
