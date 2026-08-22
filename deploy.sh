#!/usr/bin/env bash
# webchatproxy deployment helper.
# Usage: ./deploy.sh [sync|deploy|restart|all]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE_HOST="${WEBCHAT_DEPLOY_HOST:-}"
REMOTE_USER="${WEBCHAT_DEPLOY_USER:-}"
REMOTE_ROOT="${WEBCHAT_DEPLOY_ROOT:-}"
ACTION="${1:-sync}"

if [ -z "$REMOTE_HOST" ] || [ -z "$REMOTE_USER" ]; then
  echo "ERROR: Set WEBCHAT_DEPLOY_HOST and WEBCHAT_DEPLOY_USER" >&2
  exit 70
fi

if [ -z "$REMOTE_ROOT" ]; then
  REMOTE_ROOT="/home/$REMOTE_USER/webchatproxy"
fi

REMOTE="$REMOTE_USER@$REMOTE_HOST"
SSH_OPTS=(-o StrictHostKeyChecking=no)

sync_proxy() {
  echo "==> Syncing webchatproxy to $REMOTE:$REMOTE_ROOT/server/"
  ssh "${SSH_OPTS[@]}" "$REMOTE" \
    "mkdir -p '$REMOTE_ROOT/server/runtime/jobs' '$REMOTE_ROOT/server/runtime/logs' '$REMOTE_ROOT/server/runtime/debug'"

  rsync -avz --delete \
    --exclude='browser-profile/' \
    --exclude='runtime/' \
    --exclude='node_modules/' \
    --exclude='.webchat-gateway.pid' \
    --exclude='*.log' \
    -e "ssh -o StrictHostKeyChecking=no" \
    "$SCRIPT_DIR/server/" "$REMOTE:$REMOTE_ROOT/server/"
}

install_proxy() {
  echo "==> Installing production dependencies"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "cd '$REMOTE_ROOT/server' && npm ci"
}

restart_proxy() {
  echo "==> Restarting webchatproxy"
  ssh "${SSH_OPTS[@]}" "$REMOTE" \
    "cd '$REMOTE_ROOT/server' && ./start.sh restart && ./start.sh status"
}

case "$ACTION" in
  sync)
    sync_proxy
    ;;
  deploy)
    sync_proxy
    install_proxy
    ;;
  restart)
    restart_proxy
    ;;
  all)
    sync_proxy
    install_proxy
    restart_proxy
    ;;
  *)
    echo "Usage: $0 [sync|deploy|restart|all]" >&2
    exit 2
    ;;
esac

echo "==> Done."
