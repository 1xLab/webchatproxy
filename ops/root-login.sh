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
  sudo ops/root-login.sh --gateway-token [TOKEN]
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
  ensure_deepseek_browser
  systemctl stop webchatproxy-deepseek-runtime.service || true
  if ! run_agent "cd '$SERVER' && DISPLAY='${WEBCHAT_DISPLAY:-:100}' DS_CDP='$DEEPSEEK_CDP' bash providers/deepseek/engine/login.sh"; then
    systemctl start webchatproxy-deepseek-runtime.service || true
    return 1
  fi
  systemctl start webchatproxy-deepseek-runtime.service
}

ensure_deepseek_browser() {
  local display="${WEBCHAT_DISPLAY:-:100}"
  local profile="$ROOT/browser-profile-deepseek"
  local port
  DEEPSEEK_CDP=""
  for port in $(seq 9333 9343); do
    if ps -eo args= | grep -F -- "--remote-debugging-port=$port" | grep -F -- "--user-data-dir=$profile" >/dev/null 2>&1 \
      && curl --max-time 2 -fsS "http://127.0.0.1:$port/json/version" >/dev/null 2>&1; then
      DEEPSEEK_CDP="http://127.0.0.1:$port"
      return 0
    fi
  done

  for port in $(seq 9333 9343); do
    if ! curl --max-time 2 -fsS "http://127.0.0.1:$port/json/version" >/dev/null 2>&1; then
      DEEPSEEK_CDP="http://127.0.0.1:$port"
      break
    fi
  done
  [ -n "$DEEPSEEK_CDP" ] || { echo "ERROR: no free DeepSeek CDP port" >&2; return 1; }

  if ! curl --max-time 2 -fsS "$DEEPSEEK_CDP/json/version" >/dev/null 2>&1; then
    systemctl start webchatproxy-browser-login.service || true
    for _ in $(seq 1 20); do
      curl --max-time 2 -fsS "http://127.0.0.1:6080/vnc.html" >/dev/null 2>&1 && break
      sleep 1
    done
    run_agent "DISPLAY='$display' nohup google-chrome --user-data-dir='$profile' --remote-debugging-port='${DEEPSEEK_CDP##*:}' --remote-debugging-address=127.0.0.1 --window-size=1920,1080 --start-maximized --no-first-run --no-default-browser-check about:blank >/home/agent/webchatproxy/runtime/deepseek/chrome.log 2>&1 </dev/null &"
    for _ in $(seq 1 30); do
      curl --max-time 2 -fsS "$DEEPSEEK_CDP/json/version" >/dev/null 2>&1 && return 0
      sleep 1
    done
    echo "ERROR: DeepSeek Chrome CDP did not start on $DEEPSEEK_CDP; open the shared noVNC portal on 6080." >&2
    return 1
  fi
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
  token="${1:-}"
  if [ -z "$token" ]; then
    token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    echo "Generated a new universal gateway token." >&2
  fi
  [ -n "$token" ] || { echo "ERROR: could not generate gateway token" >&2; return 1; }
  umask 077
  printf 'WEBCHAT_UNIVERSAL_API_TOKEN=%s\n' "$token" > "$ROOT/runtime/webchatproxy.env"
  chown "$USER_NAME:$USER_NAME" "$ROOT/runtime/webchatproxy.env"
  chmod 600 "$ROOT/runtime/webchatproxy.env"
  systemctl restart webchatproxy.service
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
    --gateway-token)
      shift
      if [ "$#" -gt 0 ] && [[ "$1" != --* ]]; then login_gateway "$1"; shift; else login_gateway; fi
      ;;
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
