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
if [ -n "$TOKEN" ]; then
  AUTH=(-H "Authorization: Bearer $TOKEN")
fi

result() {
  local kind="$1" method="$2" path="$3" code="$4" note="${5:-}"
  case "$kind" in
    PASS) PASS=$((PASS+1)) ;;
    FAIL) FAIL=$((FAIL+1)) ;;
    WARN) WARN=$((WARN+1)) ;;
  esac
  # stderr is intentional: callers may capture/redirect request stdout to obtain
  # only the HTTP code without hiding the per-endpoint PASS/FAIL line.
  printf '%-4s %-6s %-52s HTTP %-3s %s\n' "$kind" "$method" "$path" "$code" "$note" >&2
}

request() {
  local method="$1" path="$2" expected="$3"
  shift 3
  : > "$LAST_BODY"
  : > "$LAST_HEADERS"
  : > "$TMP_DIR/curl.err"
  local code
  code=$(curl -sS --max-time "${WEBCHAT_TEST_TIMEOUT:-20}" \
    -D "$LAST_HEADERS" -o "$LAST_BODY" -w '%{http_code}' \
    -X "$method" "${AUTH[@]}" "$@" "$BASE_URL$path" 2>"$TMP_DIR/curl.err") || code="000"

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
  local expr="$1"
  node -e '
    const fs=require("fs");
    try {
      const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      const path=process.argv[2].split(".");
      let v=x;
      for (const p of path) v=v?.[p];
      if (v !== undefined && v !== null) process.stdout.write(String(v));
    } catch {}
  ' "$LAST_BODY" "$expr"
}

printf 'webchatproxy endpoint test\n'
printf 'BASE_URL=%s\n\n' "$BASE_URL"

# Core/health. /ready is strict: degraded runtime is a failed production test.
request GET /health '200' >/dev/null
request GET /ready '200' >/dev/null
request GET /v1/account '200' >/dev/null
request GET /v1/models '200' >/dev/null

# Projects control plane. Local catalog import is tested separately from the live
# ChatGPT Project surface so a synthetic project id is never sent upstream.
request GET '/v1/projects' '200' >/dev/null
request POST /v1/projects/import '200' -H 'Content-Type: application/json' \
  -d '{"projects":{"Endpoint Test":{"id":"g-p-endpointtest","aliases":["endpoint-test"]}}}' >/dev/null
request GET '/v1/projects?live=1&sync=0' '200' >/dev/null
REAL_PROJECT_ID=$(json_value projects.0.id)
request POST /v1/projects/sync '200' -H 'Content-Type: application/json' -d '{}' >/dev/null

if [ -n "$REAL_PROJECT_ID" ]; then
  request GET "/v1/projects/$REAL_PROJECT_ID/conversations?limit=1" '200' >/dev/null
  request GET "/v1/projects/$REAL_PROJECT_ID/files" '200' >/dev/null
else
  result WARN GET '/v1/projects/{real-id}/conversations' '---' 'no live ChatGPT Project returned by account'
  result WARN GET '/v1/projects/{real-id}/files' '---' 'no live ChatGPT Project returned by account'
fi

# Conversations. Global list must work. A deliberately unknown id may be 404 or
# an upstream 4xx depending on ChatGPT behavior, but it must never hang.
request GET '/v1/conversations?limit=1' '200' >/dev/null
request GET '/v1/conversations/nonexistent' '400,404' >/dev/null

# File staging lifecycle.
printf 'webchatproxy endpoint test\n' > "$TMP_DIR/upload.txt"
request POST /v1/files '201' \
  -H 'Content-Type: text/plain' \
  -H 'X-Filename: endpoint-test.txt' \
  --data-binary @"$TMP_DIR/upload.txt" >/dev/null
FILE_ID=$(json_value file.id)
if [ -n "$FILE_ID" ]; then
  request GET "/v1/files/$FILE_ID" '200' >/dev/null
else
  result FAIL GET '/v1/files/{id}' '---' 'upload did not return file.id'
fi

# Jobs lifecycle.
request POST /v1/jobs '202' -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"WEBCHAT_ENDPOINT_TEST"}],"model":"chatgpt-web"}' >/dev/null
JOB_ID=$(json_value job.id)
request GET /v1/jobs '200' >/dev/null
if [ -n "$JOB_ID" ]; then
  request GET "/v1/jobs/$JOB_ID" '200' >/dev/null
  request GET "/v1/jobs/$JOB_ID/events" '200' >/dev/null
else
  result FAIL GET '/v1/jobs/{id}' '---' 'job creation did not return job.id'
  result FAIL GET '/v1/jobs/{id}/events' '---' 'job creation did not return job.id'
fi

# OpenAI-style endpoint, async so the script validates acceptance without waiting
# for a full model generation. Engine health is already enforced above.
request POST /v1/chat/completions '202' -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"WEBCHAT_ENDPOINT_TEST"}],"model":"chatgpt-web","async":true}' >/dev/null
CHAT_JOB_ID=$(json_value id)

# Debug/diagnostics.
request GET /v1/debug/config '200' >/dev/null
request GET /v1/debug/runtime '200' >/dev/null
request GET /v1/debug/doctor '200' >/dev/null
request GET /v1/debug/dom '501' >/dev/null
request GET '/v1/debug/events?limit=10' '200' >/dev/null
request GET /v1/debug/screenshot '501' >/dev/null
request POST /v1/debug/bundle '201' >/dev/null

# This endpoint is intentionally disruptive. Test only when explicitly enabled.
if [ "${WEBCHAT_TEST_RESTART:-0}" = "1" ]; then
  request POST /v1/debug/browser/restart '200' >/dev/null
else
  result WARN POST /v1/debug/browser/restart '---' 'skipped; set WEBCHAT_TEST_RESTART=1 to execute'
fi

request POST /v1/debug/smoke '202' >/dev/null

# CORS/preflight route.
request OPTIONS /v1/models '204' >/dev/null

# Cleanup generated resources.
if [ -n "$CHAT_JOB_ID" ]; then
  request DELETE "/v1/jobs/$CHAT_JOB_ID" '200,404,409' >/dev/null
fi
if [ -n "$JOB_ID" ]; then
  request DELETE "/v1/jobs/$JOB_ID" '200,404,409' >/dev/null
fi
if [ -n "$FILE_ID" ]; then
  request DELETE "/v1/files/$FILE_ID" '200' >/dev/null
fi

printf '\nSummary: PASS=%d FAIL=%d WARN=%d\n' "$PASS" "$FAIL" "$WARN"

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
