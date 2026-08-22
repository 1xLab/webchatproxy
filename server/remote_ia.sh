#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
port="${WEBCHAT_PORT:-${PORT:-3210}}"
base_url="${WEBCHAT_GATEWAY_URL:-http://127.0.0.1:${port}}"
url="${REMOTE_IA_URL:-${base_url}/v1/chat/completions}"
status_url="${REMOTE_IA_STATUS_URL:-${base_url}/health}"
model="${REMOTE_IA_MODEL:-chatgpt-web}"
timeout="${REMOTE_IA_TIMEOUT:-300}"
token="${WEBCHAT_API_TOKEN:-${REMOTE_IA_TOKEN:-}}"

auth_args=()
if [ -n "$token" ]; then
  auth_args=(-H "Authorization: Bearer $token")
fi

ensure_gateway() {
  if curl -fsS --max-time 2 "$status_url" >/dev/null 2>&1; then
    return 0
  fi

  if [ ! -x "$script_dir/start.sh" ]; then
    printf 'Erro: start.sh standalone não encontrado/executável em %s.\n' "$script_dir" >&2
    return 1
  fi

  printf 'WebChat Gateway indisponível; iniciando serviço standalone na porta %s...\n' "$port" >&2
  (
    cd "$script_dir"
    WEBCHAT_PORT="$port" ./start.sh start
  ) >&2

  if ! curl -fsS --max-time 3 "$status_url" >/dev/null 2>&1; then
    printf 'Erro: gateway não respondeu em %s após o start.\n' "$status_url" >&2
    return 1
  fi
}

if [ -t 0 ]; then
  printf 'Prompt: ' >&2
fi

prompt="$(</dev/stdin)"

if [ -z "${prompt//[[:space:]]/}" ]; then
  printf 'Erro: prompt vazio. Use pipe ou digite o texto e finalize com Ctrl-D.\n' >&2
  exit 1
fi

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

escaped_prompt="$(printf '%s' "$prompt" | json_escape)"

ensure_gateway

set +e
response="$(
  curl -sS \
    --max-time "$timeout" \
    -H 'Content-Type: application/json' \
    "${auth_args[@]}" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":$escaped_prompt}]}" \
    "$url"
)"
curl_status=$?
set -e

if [ "$curl_status" -ne 0 ]; then
  exit "$curl_status"
fi

printf '%s' "$response" | python3 -c '
import json, sys

raw = sys.stdin.read()
try:
    data = json.loads(raw)
except json.JSONDecodeError:
    print(raw)
    sys.exit(0)

if "error" in data:
    error = data["error"]
    if isinstance(error, dict):
        print(error.get("message", error))
    else:
        print(error)
    sys.exit(1)

try:
    print(data["choices"][0]["message"]["content"])
except (KeyError, IndexError, TypeError):
    print(raw)
'
