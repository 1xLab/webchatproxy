#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0" >&2
  exit 77
fi

"$ROOT/deploy.sh"
"$ROOT/ops/root-restart.sh"
"$ROOT/ops/root-validate.sh"
