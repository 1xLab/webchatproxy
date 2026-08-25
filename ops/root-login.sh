#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SERVER="$ROOT/server"
USER_NAME="${WEBCHAT_USER:-agent}"

usage() {
  cat <<'EOF'
Usage:
  sudo ops/root-login.sh --help
  sudo ops/root-login.sh --agy ACCOUNT [ACCOUNT ...]
  sudo ops/root-login.sh --chatgpt
  sudo ops/root-login.sh --deepseek
  sudo ops/root-login.sh --kimi
  sudo ops/root-login.sh --codex
  sudo ops/root-login.sh --gateway-token
  sudo ops/root-login.sh --all

Examples:
  sudo ops/root-login.sh --agy 1 2 3
  sudo ops/root-login.sh --chatgpt --deepseek --kimi --codex
EOF
}

if [ "${1:-}" = --help ] || [ "$#" -eq 0 ]; then
  usage
  [ "$#" -eq 0 ] && exit 2 || exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0 ..." >&2
  exit 77
fi

run_agent() {
  su -s /bin/bash "$USER_NAME" -c "$*"
}

login_agy() {
  local account="$1"
  [[ "$account" =~ ^([1-9]|10)$ ]] || { echo "Invalid AGY account: $account" >&2; return 2; }
  systemctl stop "webchatproxy-antigravity@$account.service" || true
  if ! run_agent "cd '$SERVER' && bash providers/antigravity/engine/login-account.sh '$account'"; then
    systemctl start "webchatproxy-antigravity@$account.service" || true
    return 1
  fi
  systemctl start "webchatproxy-antigravity@$account.service"
}

login_chatgpt() {
  export DISPLAY="${WEBCHAT_DISPLAY:-:100}"
  bash "$ROOT/login-chatgpt.sh"
}

login_deepseek() {
  systemctl stop webchatproxy-deepseek-runtime.service || true
  if ! run_agent "cd '$SERVER' && bash providers/deepseek/engine/login.sh"; then
    systemctl start webchatproxy-deepseek-runtime.service || true
    return 1
  fi
  systemctl start webchatproxy-deepseek-runtime.service
}

login_kimi() {
  systemctl stop webchatproxy-kimi-runtime.service || true
  if ! run_agent "cd '$SERVER' && bash providers/kimi/engine/import-token.sh"; then
    systemctl start webchatproxy-kimi-runtime.service || true
    return 1
  fi
  systemctl start webchatproxy-kimi-runtime.service
}

login_codex() {
  bash "$SERVER/browser-login/codex-oauth.sh"
}

login_gateway() {
  local token
  printf 'Universal gateway token: ' >&2
  IFS= read -r -s token
  printf '\n' >&2
  [ -n "$token" ] || { echo "ERROR: empty gateway token" >&2; return 64; }
  umask 077
  printf 'WEBCHAT_UNIVERSAL_API_TOKEN=%s\n' "$token" > "$ROOT/runtime/webchatproxy.env"
  chown "$USER_NAME:$USER_NAME" "$ROOT/runtime/webchatproxy.env"
  chmod 600 "$ROOT/runtime/webchatproxy.env"
  echo "Universal gateway token saved."
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --agy)
      shift
      [ "$#" -gt 0 ] || { echo "--agy requires one or more account numbers" >&2; exit 2; }
      while [ "$#" -gt 0 ] && [[ "$1" != --* ]]; do login_agy "$1"; shift; done
      ;;
    --chatgpt) login_chatgpt; shift ;;
    --deepseek) login_deepseek; shift ;;
    --kimi) login_kimi; shift ;;
    --codex) login_codex; shift ;;
    --gateway-token) login_gateway; shift ;;
    --all)
      for account in $(seq 1 10); do login_agy "$account"; done
      login_chatgpt
      login_deepseek
      login_kimi
      login_codex
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

echo "Requested provider logins completed. Run root-provider-validate.sh." 
