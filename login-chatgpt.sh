#!/usr/bin/env bash
set -euo pipefail

if [ -z "${DISPLAY:-}" ]; then
  echo "DISPLAY ausente. Execute este script em uma sessão SSH iniciada pelo xterm do XQuartz." >&2
  exit 2
fi

systemctl stop webchatproxy-chatgpt-runtime.service

runuser -u agent -- env \
  DISPLAY="$DISPLAY" \
  HOME=/home/agent \
  google-chrome \
  --user-data-dir=/home/agent/webchatproxy/browser-profile \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --no-first-run \
  https://chatgpt.com &
chrome_pid=$!

cleanup() {
  kill "$chrome_pid" 2>/dev/null || true
  wait "$chrome_pid" 2>/dev/null || true
  systemctl start webchatproxy-chatgpt-runtime.service
  echo "ChatGPT runtime reiniciado."
}
trap cleanup INT TERM
wait "$chrome_pid"
