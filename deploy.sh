#!/usr/bin/env bash
# WebChat full deploy script: syncs both gateway (server/) and Laravel app (sistema/).
# Usage: ./deploy.sh [sync|deploy|restart|all]
#   sync      - rsync server/ and sistema/ to remote (default)
#   deploy    - sync + run sistema/deploy.sh on remote (npm ci, composer, migrations)
#   restart   - restart gateway service via start.sh
#   all       - sync + deploy + restart
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE_HOST="${WEBCHAT_DEPLOY_HOST:-}"
REMOTE_USER="${WEBCHAT_DEPLOY_USER:-}"
REMOTE_HOME="${WEBCHAT_DEPLOY_HOME:-/home/$(whoami)}"

if [ -z "$REMOTE_HOST" ] || [ -z "$REMOTE_USER" ]; then
  echo "ERROR: Set WEBCHAT_DEPLOY_HOST and WEBCHAT_DEPLOY_USER env vars" >&2
  echo "Example: WEBCHAT_DEPLOY_HOST=147.93.183.134 WEBCHAT_DEPLOY_USER=agent ./deploy.sh all" >&2
  exit 70
fi

ACTION="${1:-sync}"
REMOTE="$REMOTE_USER@$REMOTE_HOST"

sync_server() {
  echo "==> Syncing server/ directory to $REMOTE:$REMOTE_HOME/server/"
  rsync -avz --delete \
    --exclude='browser-profile/' \
    --exclude='runtime/' \
    --exclude='node_modules/' \
    --exclude='.webchat-gateway.pid' \
    --exclude='*.log' \
    -e "ssh -o StrictHostKeyChecking=no" \
    "$SCRIPT_DIR/server/" "$REMOTE:$REMOTE_HOME/server/"
  ssh -o StrictHostKeyChecking=no "$REMOTE" "mkdir -p $REMOTE_HOME/server/runtime/jobs $REMOTE_HOME/server/runtime/logs $REMOTE_HOME/server/runtime/debug"
  echo "==> Server directory synced. Runtime dirs ensured."
}

sync_laravel() {
  echo "==> Syncing sistema/ directory to $REMOTE:$REMOTE_HOME/sistema/"
  rsync -avz --delete \
    --exclude='vendor/' \
    --exclude='node_modules/' \
    --exclude='.env' \
    --exclude='storage/framework/cache/' \
    --exclude='storage/framework/sessions/' \
    --exclude='storage/framework/views/*.php' \
    --exclude='storage/logs/laravel.log' \
    -e "ssh -o StrictHostKeyChecking=no" \
    "$SCRIPT_DIR/sistema/" "$REMOTE:$REMOTE_HOME/sistema/"
  echo "==> Laravel directory synced."
}

sync_public_html() {
  echo "==> Syncing public_html/ directory to $REMOTE:$REMOTE_HOME/public_html/"
  rsync -avz --delete \
    --exclude='.htaccess' \
    -e "ssh -o StrictHostKeyChecking=no" \
    "$SCRIPT_DIR/public_html/" "$REMOTE:$REMOTE_HOME/public_html/"
  echo "==> Public_html directory synced."
}

run_deploy() {
  echo "==> Running Laravel deploy on $REMOTE"
  ssh -o StrictHostKeyChecking=no "$REMOTE" "cd $REMOTE_HOME/sistema && bash deploy.sh"
  echo "==> Laravel deploy complete."
}

restart_gateway() {
  echo "==> Restarting gateway on $REMOTE"
  ssh -o StrictHostKeyChecking=no "$REMOTE" "cd $REMOTE_HOME/server && ./start.sh restart"
  echo "==> Gateway restarted."
  ssh -o StrictHostKeyChecking=no "$REMOTE" "cd $REMOTE_HOME/server && ./start.sh status"
}

case "$ACTION" in
  sync)
    sync_server
    sync_laravel
    sync_public_html
    ;;
  deploy)
    sync_server
    sync_laravel
    sync_public_html
    run_deploy
    ;;
  restart)
    restart_gateway
    ;;
  all)
    sync_server
    sync_laravel
    sync_public_html
    run_deploy
    restart_gateway
    ;;
  *)
    echo "Unknown action: $ACTION" >&2
    echo "Usage: $0 [sync|deploy|restart|all]" >&2
    exit 1
    ;;
esac

echo "==> Done."
