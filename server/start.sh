#!/usr/bin/env bash
# webchatproxy — standalone Playwright service.
# Usage: ./start.sh [start|stop|restart|status|doctor|doctor-live|browser-install|browser-auth|logs]
set -euo pipefail

cd "$(dirname "$0")"
CORE_DIR="$(pwd -P)"

# The Node/Playwright core, browser profile and runtime must never run from a
# public document root. Existing production service layout is /home/<user>/server.
reject_public_webroot() {
  local label="$1"
  local path="$2"
  local resolved
  resolved="$(realpath -m "$path")"
  case "$resolved" in
    */public_html|*/public_html/*)
      echo "ERROR: $label must not live under public_html: $resolved"
      echo "Keep the proxy core, runtime and browser profile outside any document root."
      return 78
      ;;
  esac
}

PID_FILE=".webchat-gateway.pid"
RUNTIME_DIR="${WEBCHAT_RUNTIME_DIR:-$CORE_DIR/runtime}"
PROFILE_DIR="${WEBCHAT_PROFILE_DIR:-$CORE_DIR/browser-profile}"
LOG_FILE="${WEBCHAT_PROCESS_LOG:-$RUNTIME_DIR/logs/process.log}"
XVFB_LOG_FILE="${WEBCHAT_XVFB_LOG:-$RUNTIME_DIR/logs/xvfb.log}"
DISPLAY_FILE="$RUNTIME_DIR/display"
HOST="${WEBCHAT_HOST:-127.0.0.1}"
WEBCHAT_PORT="${WEBCHAT_PORT:-${PORT:-3210}}"
NOFILE_TARGET="${WEBCHAT_NOFILE:-65535}"

reject_public_webroot "gateway core" "$CORE_DIR"
reject_public_webroot "gateway runtime" "$RUNTIME_DIR"
reject_public_webroot "browser profile" "$PROFILE_DIR"

# Server-safe defaults:
# - use Playwright-managed Chromium unless REMOTE_IA_BROWSER_CHANNEL is explicit;
# - run a real headed Chromium by default;
# - when no graphical DISPLAY is supplied, xvfb-run owns a private X server,
#   chooses a free display automatically and injects DISPLAY into the same
#   process tree as Node/Chromium. No RDP/VNC or visible desktop is required.
BROWSER_CHANNEL="${REMOTE_IA_BROWSER_CHANNEL:-}"
BROWSER_LABEL="${BROWSER_CHANNEL:-playwright-default}"
HEADLESS="${WEBCHAT_HEADLESS:-${REMOTE_IA_HEADLESS:-0}}"
XVFB_SCREEN="${WEBCHAT_XVFB_SCREEN:-1920x1080x24}"

export WEBCHAT_PORT WEBCHAT_HOST="$HOST" WEBCHAT_RUNTIME_DIR="$RUNTIME_DIR"
export WEBCHAT_PROFILE_DIR="$PROFILE_DIR" WEBCHAT_HEADLESS="$HEADLESS"
HEALTH_URL="http://${HOST}:${WEBCHAT_PORT}/health"

mkdir -p "$RUNTIME_DIR/logs" "$RUNTIME_DIR/debug" "$RUNTIME_DIR/jobs"

is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

port_busy() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$WEBCHAT_PORT" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  curl -fsS --max-time 1 "$HEALTH_URL" >/dev/null 2>&1
}

ensure_nofile_limit() {
  if ! [[ "$NOFILE_TARGET" =~ ^[0-9]+$ ]] || [ "$NOFILE_TARGET" -lt 256 ]; then
    echo "ERROR: WEBCHAT_NOFILE must be an integer >= 256 (got: $NOFILE_TARGET)."
    return 78
  fi

  local soft hard
  soft="$(ulimit -Sn)"
  hard="$(ulimit -Hn)"
  if [ "$soft" = "unlimited" ]; then return 0; fi

  if [ "$hard" != "unlimited" ] && [ "$hard" -lt "$NOFILE_TARGET" ]; then
    echo "ERROR: RLIMIT_NOFILE too low for Chrome: soft=$soft hard=$hard required=$NOFILE_TARGET"
    echo "Start from a service/session with LimitNOFILE=$NOFILE_TARGET (or equivalent)."
    return 78
  fi

  if [ "$soft" -lt "$NOFILE_TARGET" ]; then
    ulimit -Sn "$NOFILE_TARGET"
    soft="$(ulimit -Sn)"
  fi

  if [ "$soft" != "unlimited" ] && [ "$soft" -lt "$NOFILE_TARGET" ]; then
    echo "ERROR: failed to raise RLIMIT_NOFILE: soft=$soft required=$NOFILE_TARGET"
    return 78
  fi
}

ensure_dependencies() {
  if [ ! -d node_modules ]; then
    if [ -f package-lock.json ]; then npm ci; else npm install; fi
  fi
}

ensure_headed_runtime() {
  if [ "$HEADLESS" = "1" ] || [ -n "${DISPLAY:-}" ]; then return 0; fi
  if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "ERROR: headed Chromium requires xvfb-run when DISPLAY is not set."
    echo "Install Xvfb or set WEBCHAT_HEADLESS=1 explicitly."
    return 1
  fi
  if ! command -v setsid >/dev/null 2>&1; then
    echo "ERROR: setsid is required to supervise the gateway/Xvfb process group."
    return 1
  fi
}

install_browser() {
  ensure_dependencies
  echo "Installing Playwright Chromium for the current user..."
  echo "channel=$BROWSER_LABEL headless=$HEADLESS"
  npx playwright install chromium
  echo
  npx playwright install --list
}

stop_service() {
  if is_running; then
    local pid
    pid="$(cat "$PID_FILE")"
    echo "Stopping webchatproxy process group (PGID $pid)..."
    kill -TERM -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    for _ in {1..60}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL -- "-$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$PID_FILE" "$DISPLAY_FILE"
}

start_service() {
  if is_running; then
    echo "webchatproxy already running (PID $(cat "$PID_FILE")) on port $WEBCHAT_PORT"
    return 0
  fi
  if port_busy; then
    echo "ERROR: dedicated port $WEBCHAT_PORT is already in use by another process."
    echo "Set WEBCHAT_PORT to a free port; this service will not take over an occupied port."
    return 2
  fi

  ensure_nofile_limit
  ensure_dependencies
  ensure_headed_runtime

  if [ -f "$LOG_FILE" ] && [ -s "$LOG_FILE" ]; then
    mv "$LOG_FILE" "$LOG_FILE.$(date +%Y%m%d_%H%M%S)" 2>/dev/null || true
  fi
  : > "$XVFB_LOG_FILE"
  rm -f "$DISPLAY_FILE"

  echo "Starting webchatproxy on ${HOST}:${WEBCHAT_PORT}..."
  echo "Core=$CORE_DIR runtime=$RUNTIME_DIR profile=$PROFILE_DIR nofile=$(ulimit -Sn)"

  if [ "$HEADLESS" = "1" ]; then
    echo "Browser channel=${BROWSER_LABEL} headless=1 display=none"
    nohup setsid env \
      WEBCHAT_PORT="$WEBCHAT_PORT" \
      WEBCHAT_HOST="$HOST" \
      WEBCHAT_RUNTIME_DIR="$RUNTIME_DIR" \
      WEBCHAT_PROFILE_DIR="$PROFILE_DIR" \
      WEBCHAT_HEADLESS=1 \
      node bootstrap.mjs >> "$LOG_FILE" 2>&1 &
  elif [ -n "${DISPLAY:-}" ]; then
    echo "Browser channel=${BROWSER_LABEL} headless=0 display=$DISPLAY (external)"
    printf '%s\n' "$DISPLAY" > "$DISPLAY_FILE"
    nohup setsid env \
      WEBCHAT_PORT="$WEBCHAT_PORT" \
      WEBCHAT_HOST="$HOST" \
      WEBCHAT_RUNTIME_DIR="$RUNTIME_DIR" \
      WEBCHAT_PROFILE_DIR="$PROFILE_DIR" \
      WEBCHAT_HEADLESS=0 \
      DISPLAY="$DISPLAY" \
      node bootstrap.mjs >> "$LOG_FILE" 2>&1 &
  else
    echo "Browser channel=${BROWSER_LABEL} headless=0 display=xvfb-auto"
    nohup setsid env \
      WEBCHAT_PORT="$WEBCHAT_PORT" \
      WEBCHAT_HOST="$HOST" \
      WEBCHAT_RUNTIME_DIR="$RUNTIME_DIR" \
      WEBCHAT_PROFILE_DIR="$PROFILE_DIR" \
      WEBCHAT_HEADLESS=0 \
      WEBCHAT_DISPLAY_FILE="$DISPLAY_FILE" \
      xvfb-run -a -e "$XVFB_LOG_FILE" \
        -s "-screen 0 $XVFB_SCREEN -nolisten tcp -noreset" \
        sh -c 'printf "%s\n" "$DISPLAY" > "$WEBCHAT_DISPLAY_FILE"; exec node bootstrap.mjs' \
        >> "$LOG_FILE" 2>&1 &
  fi

  local pid=$!
  printf '%s\n' "$pid" > "$PID_FILE"

  for _ in {1..120}; do
    if curl -fsS --max-time 1 "$HEALTH_URL" >/dev/null 2>&1; then
      local active_display="none"
      if [ -s "$DISPLAY_FILE" ]; then active_display="$(cat "$DISPLAY_FILE")"; fi
      echo "webchatproxy ready: $HEALTH_URL (PID $pid)"
      echo "Runtime headless=$HEADLESS display=$active_display nofile=$(ulimit -Sn)"
      node doctor.mjs || true
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "ERROR: gateway/Xvfb supervisor exited during startup."
      tail -n 120 "$LOG_FILE" 2>/dev/null || true
      echo "--- Xvfb log ---"
      tail -n 80 "$XVFB_LOG_FILE" 2>/dev/null || true
      rm -f "$PID_FILE" "$DISPLAY_FILE"
      return 1
    fi
    sleep 0.25
  done

  echo "ERROR: gateway did not expose /health. Diagnostic log follows:"
  tail -n 120 "$LOG_FILE" 2>/dev/null || true
  echo "--- Xvfb log ---"
  tail -n 80 "$XVFB_LOG_FILE" 2>/dev/null || true
  stop_service
  return 1
}

browser_auth() {
  ensure_nofile_limit
  ensure_dependencies
  if is_running; then
    echo "Stopping gateway before browser authentication so the same browser-profile is not opened twice..."
    stop_service
  fi

  echo "Starting headed Chromium with the canonical browser-profile..."
  echo "profile=$PROFILE_DIR"
  echo "nofile=$(ulimit -Sn)"

  if [ -n "${DISPLAY:-}" ]; then
    echo "display=$DISPLAY (external)"
    WEBCHAT_PROFILE_DIR="$PROFILE_DIR" WEBCHAT_HEADLESS=0 DISPLAY="$DISPLAY" node browser-auth.mjs
    return
  fi

  if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "ERROR: browser-auth requires DISPLAY or xvfb-run."
    return 1
  fi

  echo "display=xvfb-auto"
  WEBCHAT_PROFILE_DIR="$PROFILE_DIR" WEBCHAT_HEADLESS=0 xvfb-run -a -e "$XVFB_LOG_FILE" \
    -s "-screen 0 $XVFB_SCREEN -nolisten tcp -noreset" \
    node browser-auth.mjs
}

status_service() {
  local active_display="none"
  if [ -s "$DISPLAY_FILE" ]; then active_display="$(cat "$DISPLAY_FILE")"; fi
  if is_running; then
    echo "running pid=$(cat "$PID_FILE") host=$HOST port=$WEBCHAT_PORT browser=$BROWSER_LABEL headless=$HEADLESS display=$active_display core=$CORE_DIR runtime=$RUNTIME_DIR profile=$PROFILE_DIR"
    curl -fsS --max-time 3 "$HEALTH_URL" || true
    echo
  else
    echo "stopped host=$HOST port=$WEBCHAT_PORT browser=$BROWSER_LABEL headless=$HEADLESS display=$active_display core=$CORE_DIR runtime=$RUNTIME_DIR profile=$PROFILE_DIR"
    return 1
  fi
}

cmd="${1:-start}"
case "$cmd" in
  start) start_service ;;
  restart) stop_service; start_service ;;
  stop) stop_service; echo "webchatproxy stopped." ;;
  status) status_service ;;
  doctor) ensure_dependencies; node doctor.mjs ;;
  doctor-live) ensure_dependencies; node doctor.mjs --live ;;
  browser-install) install_browser ;;
  browser-auth) browser_auth ;;
  logs) tail -n "${LINES:-200}" "$LOG_FILE" ;;
  *) echo "Usage: $0 [start|stop|restart|status|doctor|doctor-live|browser-install|browser-auth|logs]"; exit 2 ;;
esac
