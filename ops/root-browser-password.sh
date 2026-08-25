#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0 [PASSWORD]" >&2
  exit 77
fi

PASSWORD="${1:-}"
if [ -z "$PASSWORD" ]; then
  PASSWORD="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
  echo "Generated browser portal password: $PASSWORD"
fi

WEBCHAT_BROWSER_PASSWORD="$PASSWORD" bash "$ROOT/server/browser-login/setup-root.sh"
echo "Browser portal user: login"
