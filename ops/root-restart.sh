#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
USER_NAME="${WEBCHAT_USER:-agent}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0" >&2
  exit 77
fi

systemctl daemon-reload

for unit in \
  webchatproxy-chatgpt-runtime.service \
  webchatproxy-deepseek-runtime.service \
  webchatproxy-kimi-runtime.service \
  webchatproxy-antigravity-pool.service; do
  systemctl restart "$unit" || true
done

for n in $(seq 1 10); do
  unit="webchatproxy-antigravity@${n}.service"
  if [ -d "/home/$USER_NAME/.agy/account-$n" ] || systemctl is-enabled --quiet "$unit" 2>/dev/null; then
    systemctl restart "$unit" || true
  fi
done

systemctl restart webchatproxy.service

echo "WebChatProxy services restarted."
