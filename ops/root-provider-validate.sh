#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
RUNTIME="$ROOT/runtime"
TOKEN_FILE="$RUNTIME/webchatproxy.env"
USER_NAME="${WEBCHAT_USER:-agent}"
failures=0

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0" >&2
  exit 77
fi

read_env_value() {
  awk -F= -v key="$1" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "$TOKEN_FILE"
}

TOKEN="$(read_env_value WEBCHAT_UNIVERSAL_API_TOKEN 2>/dev/null || true)"

check_file() {
  local path="$1"
  if [ -s "$path" ]; then
    echo "PASS file $path"
  else
    echo "FAIL file $path"
    failures=$((failures + 1))
  fi
}

check_http() {
  local name="$1" url="$2" key="$3" body code count
  body="$(mktemp)"
  if [ "$key" = token ]; then
    code="$(curl --max-time 30 -sS -o "$body" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$url" || true)"
  elif [ -n "$key" ]; then
    code="$(curl --max-time 30 -sS -o "$body" -w '%{http_code}' -H "Authorization: Bearer $key" "$url" || true)"
  else
    code="$(curl --max-time 30 -sS -o "$body" -w '%{http_code}' "$url" || true)"
  fi
  if [ "$code" = 200 ]; then
    count="$(jq -r 'if (.data|type)=="array" then (.data|length|tostring) else (.ok // .engine.status // "ok") end' "$body" 2>/dev/null || printf '%s' ok)"
    echo "PASS $name http=$code result=$count"
  else
    echo "FAIL $name http=$code"
    jq -c '{error,ok,engine}' "$body" 2>/dev/null || true
    failures=$((failures + 1))
  fi
  rm -f "$body"
}

check_active_agy_worker() {
  local port="$1" account="$2"
  if ! systemctl is-active --quiet "webchatproxy-antigravity@$account.service"; then
    echo "SKIP agy-worker-$port service inactive"
    return 0
  fi
  check_http "agy-worker-$port" "http://127.0.0.1:$port/health" ""
}

echo "== credential files =="
check_file "$TOKEN_FILE"
check_file "$RUNTIME/codex/auth.json"
check_file "$RUNTIME/deepseek/.api-key"
check_file "$RUNTIME/kimi/.api-key"
check_file "$RUNTIME/kimi/access_token"
check_file "$RUNTIME/kimi/refresh_token"
check_file "$RUNTIME/antigravity-pool/.api-key"

if [ -z "$TOKEN" ]; then
  echo "FAIL universal token is empty"
  failures=$((failures + 1))
fi

echo "== provider checks =="
check_http chatgpt-runtime http://127.0.0.1:3310/health ""
check_http chatgpt-models http://127.0.0.1:3210/v1/models token
check_http deepseek-models http://127.0.0.1:3220/v1/models token
check_http kimi-models http://127.0.0.1:3230/v1/models token
check_http antigravity-models http://127.0.0.1:3240/v1/models token

echo "== Codex OAuth =="
codex_status="$(curl --max-time 30 -sS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3250/v1/auth/codex/status || true)"
if [ "$(printf '%s' "$codex_status" | jq -r '.authenticated // false' 2>/dev/null)" = true ]; then
  echo "PASS codex-oauth authenticated"
else
  echo "FAIL codex-oauth unauthenticated"
  failures=$((failures + 1))
fi

echo "== Codex live completion =="
codex_body="$(mktemp)"
codex_code="$(jq -n '{model:"gpt-5.5",messages:[{role:"user",content:"oi. Responda exatamente: RESPONDA_OK"}]}' | curl --max-time 180 -sS -o "$codex_body" -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' http://127.0.0.1:3250/v1/chat/completions --data-binary @- || true)"
codex_content="$(jq -r '.choices[0].message.content // ""' "$codex_body" 2>/dev/null || true)"
if [ "$codex_code" = 200 ] && printf '%s' "$codex_content" | tr '[:lower:]' '[:upper:]' | grep -Fq 'RESPONDA_OK'; then
  echo "PASS codex-live model=gpt-5.5 content=${codex_content//$'\n'/ }"
else
  echo "FAIL codex-live http=$codex_code model=gpt-5.5"
  jq -c '{error,model,choices}' "$codex_body" 2>/dev/null || true
  failures=$((failures + 1))
fi
rm -f "$codex_body"

echo "== AGY workers =="
check_active_agy_worker 3251 1
check_active_agy_worker 3252 2
check_active_agy_worker 3253 3

if ((failures)); then
  echo "Provider validation failed: $failures check(s)." >&2
  exit 1
fi
echo "Provider validation passed: all providers authenticated and reachable."
