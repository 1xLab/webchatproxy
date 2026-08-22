#!/usr/bin/env bash
set -u

BASE_URL="${WEBCHAT_GATEWAY_URL:-http://127.0.0.1:${WEBCHAT_PORT:-3210}}"
TOKEN="${WEBCHAT_API_TOKEN:-}"
TMP_DIR="${TMPDIR:-/tmp}/webchatproxy-endpoint-test.$$"
mkdir -p "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT

PASS=0
FAIL=0
WARN=0
LAST_BODY="$TMP_DIR/last-body"
LAST_HEADERS="$TMP_DIR/last-headers"

AUTH=()
if [ -n "$TOKEN" ]; then AUTH=(-H "Authorization: Bearer $TOKEN"); fi

result() {
  local kind="$1" method="$2" path="$3" code="$4" note="${5:-}"
  case "$kind" in PASS) PASS=$((PASS+1));; FAIL) FAIL=$((FAIL+1));; WARN) WARN=$((WARN+1));; esac
  printf '%-4s %-6s %-52s HTTP %-3s %s\n' "$kind" "$method" "$path" "$code" "$note" >&2
}

request() {
  local method="$1" path="$2" expected="$3"; shift 3
  : > "$LAST_BODY"; : > "$LAST_HEADERS"; : > "$TMP_DIR/curl.err"
  local code
  code=$(curl -sS --max-time "${WEBCHAT_TEST_TIMEOUT:-20}" -D "$LAST_HEADERS" -o "$LAST_BODY" -w '%{http_code}' -X "$method" "${AUTH[@]}" "$@" "$BASE_URL$path" 2>"$TMP_DIR/curl.err") || code="000"
  if [[ ",$expected," == *",$code,"* ]]; then
    result PASS "$method" "$path" "$code"
  else
    local summary
    summary=$(tr '\n' ' ' < "$LAST_BODY" | head -c 220)
    [ -z "$summary" ] && summary=$(tr '\n' ' ' < "$TMP_DIR/curl.err" | head -c 220)
    result FAIL "$method" "$path" "$code" "$summary"
  fi
  printf '%s' "$code"
}

json_value() {
  node -e '
    const fs=require("fs");
    try { const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); let v=x; for (const p of process.argv[2].split(".")) v=v?.[p]; if(v!==undefined&&v!==null) process.stdout.write(String(v)); } catch {}
  ' "$LAST_BODY" "$1"
}

printf 'webchatproxy endpoint test\nBASE_URL=%s\n\n' "$BASE_URL"

request GET /health '200' >/dev/null
request GET /ready '200' >/dev/null
request GET /v1/account '200' >/dev/null
request GET /v1/models '200' >/dev/null

request GET '/v1/projects' '200' >/dev/null
request POST /v1/projects/import '200' -H 'Content-Type: application/json' -d '{"projects":{"Endpoint Test":{"id":"g-p-endpointtest","aliases":["endpoint-test"]}}}' >/dev/null
request GET '/v1/projects?live=1&sync=0' '200' >/dev/null
REAL_PROJECT_ID=$(json_value projects.0.id)
request POST /v1/projects/sync '200' -H 'Content-Type: application/json' -d '{}' >/dev/null

if [ -n "$REAL_PROJECT_ID" ]; then
  request GET "/v1/projects/$REAL_PROJECT_ID/conversations?limit=1" '200' >/dev/null
  request GET "/v1/projects/$REAL_PROJECT_ID/files" '200' >/dev/null
  if [ "${W2A_ENABLE_WRITE:-0}" != "1" ]; then
    request PATCH "/v1/projects/$REAL_PROJECT_ID/instructions" '403' -H 'Content-Type: application/json' -d '{"instructions":"endpoint gate test"}' >/dev/null
  else
    result WARN PATCH '/v1/projects/{id}/instructions' '---' 'write gate enabled; mutation skipped by safe test'
  fi
else
  result WARN GET '/v1/projects/{real-id}/conversations' '---' 'no live ChatGPT Project returned by account'
  result WARN GET '/v1/projects/{real-id}/files' '---' 'no live ChatGPT Project returned by account'
  result WARN PATCH '/v1/projects/{real-id}/instructions' '---' 'no live ChatGPT Project returned by account'
fi

if [ "${W2A_ENABLE_WRITE:-0}" != "1" ]; then
  request POST /v1/projects '403' -H 'Content-Type: application/json' -d '{"name":"Endpoint Gate Test"}' >/dev/null
else
  result WARN POST /v1/projects '---' 'write gate enabled; project creation skipped by safe test'
fi

request GET '/v1/conversations?limit=1' '200' >/dev/null
CONVERSATION_ID=$(json_value items.0.id)
request GET '/v1/conversations/nonexistent' '200,400,404,502' >/dev/null

if [ "${W2A_ENABLE_WRITE:-0}" != "1" ]; then
  request POST /v1/conversations/nonexistent/archive '403' -H 'Content-Type: application/json' -d '{"archive":true}' >/dev/null
else
  result WARN POST '/v1/conversations/{id}/archive' '---' 'write gate enabled; archive mutation skipped by safe test'
fi
if [ "${W2A_ENABLE_DESTRUCTIVE:-0}" != "1" ]; then
  request DELETE /v1/conversations/nonexistent '403' >/dev/null
else
  result WARN DELETE '/v1/conversations/{id}' '---' 'destructive gate enabled; deletion skipped by safe test'
fi

request GET /v1/memories '200' >/dev/null
if [ "${W2A_ENABLE_WRITE:-0}" != "1" ]; then
  request POST /v1/memories '403' -H 'Content-Type: application/json' -d '{"content":"endpoint gate test"}' >/dev/null
else
  result WARN POST /v1/memories '---' 'write gate enabled; memory creation skipped by safe test'
fi
if [ "${W2A_ENABLE_DESTRUCTIVE:-0}" != "1" ]; then
  request DELETE /v1/memories/nonexistent '403' >/dev/null
else
  result WARN DELETE '/v1/memories/{id}' '---' 'destructive gate enabled; memory deletion skipped by safe test'
fi

request GET /v1/gpts '200' >/dev/null
GPT_ID=$(json_value gpts.0.id)
if [ "${WEBCHAT_TEST_GENERATION:-0}" = "1" ] && [ -n "$GPT_ID" ]; then
  request POST "/v1/gpts/$GPT_ID/chat" '200' -H 'Content-Type: application/json' -d '{"message":"Responda apenas: WEBCHAT_GPT_OK"}' >/dev/null
else
  result WARN POST '/v1/gpts/{id}/chat' '---' 'generation skipped; set WEBCHAT_TEST_GENERATION=1'
fi

printf 'webchatproxy endpoint test\n' > "$TMP_DIR/upload.txt"
request POST /v1/files '201' -H 'Content-Type: text/plain' -H 'X-Filename: endpoint-test.txt' --data-binary @"$TMP_DIR/upload.txt" >/dev/null
FILE_ID=$(json_value file.id)
if [ -n "$FILE_ID" ]; then request GET "/v1/files/$FILE_ID" '200' >/dev/null; else result FAIL GET '/v1/files/{id}' '---' 'upload did not return file.id'; fi

request POST /v1/jobs '202' -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"WEBCHAT_ENDPOINT_TEST"}],"model":"chatgpt-web"}' >/dev/null
JOB_ID=$(json_value job.id)
request GET /v1/jobs '200' >/dev/null
if [ -n "$JOB_ID" ]; then
  request GET "/v1/jobs/$JOB_ID" '200' >/dev/null
  request GET "/v1/jobs/$JOB_ID/events" '200' >/dev/null
else
  result FAIL GET '/v1/jobs/{id}' '---' 'job creation did not return job.id'
  result FAIL GET '/v1/jobs/{id}/events' '---' 'job creation did not return job.id'
fi

request POST /v1/chat/completions '202' -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"WEBCHAT_ENDPOINT_TEST"}],"model":"chatgpt-web","async":true}' >/dev/null
CHAT_JOB_ID=$(json_value id)

if [ "${WEBCHAT_TEST_GENERATION:-0}" = "1" ]; then
  : > "$LAST_BODY"; : > "$LAST_HEADERS"
  STREAM_CODE=$(curl -sS --max-time "${WEBCHAT_TEST_STREAM_TIMEOUT:-180}" -D "$LAST_HEADERS" -o "$LAST_BODY" -w '%{http_code}' "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"Responda apenas: WEBCHAT_STREAM_OK"}],"model":"chatgpt-web","stream":true}' "$BASE_URL/v1/chat/completions") || STREAM_CODE="000"
  if [ "$STREAM_CODE" = "200" ] && grep -q 'data: \[DONE\]' "$LAST_BODY"; then result PASS POST '/v1/chat/completions stream=true' "$STREAM_CODE"; else result FAIL POST '/v1/chat/completions stream=true' "$STREAM_CODE" 'SSE did not complete with [DONE]'; fi
else
  result WARN POST '/v1/chat/completions stream=true' '---' 'generation skipped; set WEBCHAT_TEST_GENERATION=1'
fi

request GET /v1/debug/config '200' >/dev/null
request GET /v1/debug/runtime '200' >/dev/null
request GET /v1/debug/doctor '200' >/dev/null
request GET /v1/debug/dom '501' >/dev/null
request GET '/v1/debug/events?limit=10' '200' >/dev/null
request GET /v1/debug/screenshot '501' >/dev/null
request POST /v1/debug/bundle '201' >/dev/null
if [ "${WEBCHAT_TEST_RESTART:-0}" = "1" ]; then request POST /v1/debug/browser/restart '200' >/dev/null; else result WARN POST /v1/debug/browser/restart '---' 'skipped; set WEBCHAT_TEST_RESTART=1'; fi
request POST /v1/debug/smoke '202' >/dev/null
request OPTIONS /v1/models '204' >/dev/null

if [ -n "$CHAT_JOB_ID" ]; then request DELETE "/v1/jobs/$CHAT_JOB_ID" '200,404,409' >/dev/null; fi
if [ -n "$JOB_ID" ]; then request DELETE "/v1/jobs/$JOB_ID" '200,404,409' >/dev/null; fi
if [ -n "$FILE_ID" ]; then request DELETE "/v1/files/$FILE_ID" '200' >/dev/null; fi

printf '\nSummary: PASS=%d FAIL=%d WARN=%d\n' "$PASS" "$FAIL" "$WARN"
[ "$FAIL" -eq 0 ]
