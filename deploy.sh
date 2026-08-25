#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
SERVER="$ROOT/server"
SYSTEMD_DIR="$SERVER/systemd"
RUNTIME="$ROOT/runtime"
USER_NAME="${WEBCHAT_USER:-agent}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0" >&2
  exit 77
fi
id "$USER_NAME" >/dev/null 2>&1 || { echo "Missing user: $USER_NAME" >&2; exit 78; }

mkdir -p "$RUNTIME" "$ROOT/browser-profile" "$ROOT/browser-profile-deepseek"
chown -R "$USER_NAME:$USER_NAME" "$RUNTIME" "$ROOT/browser-profile" "$ROOT/browser-profile-deepseek"
chmod 700 "$RUNTIME"

# Install/build pinned provider runtimes. A provider build failure must not
# prevent the universal gateway and other independent providers from starting.
failed_providers=()
install_provider() {
  local name="$1" script="$2"
  if ! su -s /bin/bash "$USER_NAME" -c "cd '$SERVER' && bash '$script'"; then
    failed_providers+=("$name")
    echo "WARNING: $name runtime installation failed; continuing without it." >&2
  fi
}
install_provider chatgpt providers/chatgpt/engine/install.sh
install_provider deepseek providers/deepseek/engine/install.sh
install_provider kimi providers/kimi/engine/install.sh
install_provider antigravity providers/antigravity/engine/install.sh

install -m 0644 "$SYSTEMD_DIR/webchatproxy.service" /etc/systemd/system/webchatproxy.service
install -m 0644 "$SYSTEMD_DIR/webchatproxy-chatgpt-runtime.service" /etc/systemd/system/webchatproxy-chatgpt-runtime.service
install -m 0644 "$SYSTEMD_DIR/webchatproxy-deepseek-runtime.service" /etc/systemd/system/webchatproxy-deepseek-runtime.service
install -m 0644 "$SYSTEMD_DIR/webchatproxy-kimi-runtime.service" /etc/systemd/system/webchatproxy-kimi-runtime.service
install -m 0644 "$SYSTEMD_DIR/webchatproxy-antigravity-pool.service" /etc/systemd/system/webchatproxy-antigravity-pool.service
install -m 0644 "$SYSTEMD_DIR/webchatproxy-antigravity@.service" /etc/systemd/system/webchatproxy-antigravity@.service

systemctl daemon-reload

# Core + runtimes that can bootstrap without an interactive login.
systemctl enable webchatproxy.service webchatproxy-chatgpt-runtime.service webchatproxy-deepseek-runtime.service webchatproxy-kimi-runtime.service webchatproxy-antigravity-pool.service >/dev/null

# Start only what has credentials/session material. Failed providers do not prevent the universal gateway from running.
systemctl restart webchatproxy-chatgpt-runtime.service || true
systemctl restart webchatproxy-deepseek-runtime.service || true
if [ -s "$RUNTIME/kimi/access_token" ]; then systemctl restart webchatproxy-kimi-runtime.service || true; fi

for n in $(seq 1 10); do
  if [ -d "/home/$USER_NAME/.agy/account-$n" ]; then
    systemctl enable "webchatproxy-antigravity@$n.service" >/dev/null
    systemctl restart "webchatproxy-antigravity@$n.service" || true
  fi
done

mkdir -p "$RUNTIME/antigravity-pool"
if [ ! -s "$RUNTIME/antigravity-pool/.api-key" ]; then
  umask 077
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$RUNTIME/antigravity-pool/.api-key"
  printf '\n' >> "$RUNTIME/antigravity-pool/.api-key"
  chown "$USER_NAME:$USER_NAME" "$RUNTIME/antigravity-pool/.api-key"
fi
systemctl restart webchatproxy-antigravity-pool.service || true
systemctl restart webchatproxy.service

if ((${#failed_providers[@]})); then
  echo "WARNING: unavailable providers: ${failed_providers[*]}" >&2
  echo "Install their host prerequisites and rerun deploy.sh to enable them." >&2
fi

echo
echo "WebChatProxy installed."
echo "  universal:    127.0.0.1:3200"
echo "  chatgpt:      127.0.0.1:3210 -> runtime 3310"
echo "  deepseek:     127.0.0.1:3220 -> runtime 3320"
echo "  kimi:         127.0.0.1:3230 -> runtime 3330"
echo "  antigravity:  127.0.0.1:3240 -> pool    3340"
echo
echo "Check: systemctl --no-pager --full status webchatproxy.service"
