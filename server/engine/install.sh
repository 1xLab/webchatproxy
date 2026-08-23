#!/usr/bin/env bash
set -euo pipefail
exec bash "$(dirname "$0")/../providers/chatgpt/engine/install.sh" "$@"
