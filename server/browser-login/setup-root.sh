#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
TEMPLATE="$ROOT/server/cwp/webchatlogin.stpl"
[ -f "$TEMPLATE" ] || TEMPLATE="$ROOT/webchatlogin.stpl"
UNIT="$ROOT/server/systemd/webchatproxy-browser-login.service"
AUTH_FILE=/etc/nginx/.webchatproxy-browser-login.htpasswd
PASSWORD_FILE=/etc/nginx/.webchatproxy-browser-login.password

install -o root -g root -m 0644 "$UNIT" /etc/systemd/system/webchatproxy-browser-login.service
mkdir -p /usr/local/cwpsrv/htdocs/resources/conf/web_servers/vhosts/nginx/php-fpm
install -o root -g root -m 0644 "$TEMPLATE" \
  /usr/local/cwpsrv/htdocs/resources/conf/web_servers/vhosts/nginx/webchatlogin.stpl
install -o root -g root -m 0644 "$TEMPLATE" \
  /usr/local/cwpsrv/htdocs/resources/conf/web_servers/vhosts/nginx/php-fpm/webchatlogin.stpl
install -o root -g root -m 0644 "$TEMPLATE" \
  /usr/local/cwpsrv/htdocs/resources/conf/web_servers/vhosts/nginx/webchatlogin.tpl
install -o root -g root -m 0644 "$TEMPLATE" \
  /usr/local/cwpsrv/htdocs/resources/conf/web_servers/vhosts/nginx/php-fpm/webchatlogin.tpl

if command -v htpasswd >/dev/null 2>&1; then
  HT="$(command -v htpasswd)"
elif [ -x /usr/local/apache/bin/htpasswd ]; then
  HT=/usr/local/apache/bin/htpasswd
else
  echo "htpasswd is required; install httpd-tools first" >&2
  exit 1
fi

if [ -s "$PASSWORD_FILE" ]; then
  PASSWORD="$(cat "$PASSWORD_FILE")"
elif [ -n "${WEBCHAT_BROWSER_PASSWORD:-}" ]; then
  PASSWORD="$WEBCHAT_BROWSER_PASSWORD"
  umask 077
  printf '%s\n' "$PASSWORD" > "$PASSWORD_FILE"
else
  umask 077
  PASSWORD="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s\n' "$PASSWORD" > "$PASSWORD_FILE"
  echo "Generated browser portal password: $PASSWORD"
fi
[ -n "$PASSWORD" ] || { echo "Browser portal password is empty" >&2; exit 1; }
printf '%s\n' "$PASSWORD" | "$HT" -i -B -c "$AUTH_FILE" login
chown root:nobody "$AUTH_FILE"
chmod 640 "$AUTH_FILE"
chown root:root "$PASSWORD_FILE"
chmod 600 "$PASSWORD_FILE"

systemctl daemon-reload
systemctl restart webchatproxy-browser-login.service
echo "Browser login portal ready on 127.0.0.1:6080"
