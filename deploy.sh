#!/usr/bin/env bash
# webchatproxy deployment helper.
# Usage: ./deploy.sh [sync|deploy|restart|all]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE_HOST="${WEBCHAT_DEPLOY_HOST:-}"
REMOTE_USER="${WEBCHAT_DEPLOY_USER:-}"
REMOTE_HOME="${WEBCHAT_DEPLOY_HOME:-}"
ACTION="${1:-sync}"

if [ -z "$REMOTE_HOST" ] || [ -z "$REMOTE_USER" ]; then
  echo "ERROR: Set WEBCHAT_DEPLOY_HOST and WEBCHAT_DEPLOY_USER" >&2
  exit 70
fi

if [ -z "$REMOTE_HOME" ]; then
  REMOTE_HOME="/home/$REMOTE_USER"
fi

REMOTE_APP_DIR="${WEBCHAT_DEPLOY_DIR:-$REMOTE_HOME/webchatproxy}"
REMOTE="$REMOTE_USER@$REMOTE_HOST"
SSH_OPTS=(-o StrictHostKeyChecking=no)

sync_proxy() {
  echo "==> Syncing server/ to $REMOTE:$REMOTE_APP_DIR/"
  ssh "${SSH_OPTS[@]}" "$REMOTE" \
    "mkdir -p '$REMOTE_APP_DIR/runtime/jobs' '$REMOTE_APP_DIR/runtime/logs' '$REMOTE_APP_DIR/runtime/debug'"

  rsync -avz --delete \
    --exclude='browser-profile/' \
    --exclude='runtime/' \
    --exclude='.venv-chatgpt/' \
    --exclude='node_modules/' \
    --exclude='.webchat-gateway.pid' \
    --exclude='*.log' \
    -e "ssh -o StrictHostKeyChecking=no" \
    "$SCRIPT_DIR/server/" "$REMOTE:$REMOTE_APP_DIR/"
}

install_proxy() {
  echo "==> Installing and validating production dependencies"
  ssh "${SSH_OPTS[@]}" "$REMOTE" \
    "cd '$REMOTE_APP_DIR' && npm ci && ./start.sh engine-install && npm run check && npm test"
}

restart_proxy() {
  echo "==> Restarting webchatproxy"
  ssh "${SSH_OPTS[@]}" "$REMOTE" \
    "cd '$REMOTE_APP_DIR' && ./start.sh restart && ./start.sh status"
}

case "$ACTION" in
  sync) sync_proxy ;;
  deploy) sync_proxy; install_proxy ;;
  restart) restart_proxy ;;
  all) sync_proxy; install_proxy; restart_proxy ;;
  *) echo "Usage: $0 [sync|deploy|restart|all]" >&2; exit 2 ;;
esac

echo "==> Done."
