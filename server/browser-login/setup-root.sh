#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
TEMPLATE="$ROOT/server/cwp/webchatlogin.stpl"
UNIT="$ROOT/server/systemd/webchatproxy-browser-login.service"
AUTH_FILE=/etc/nginx/.webchatproxy-browser-login.htpasswd

install -o root -g root -m 0644 "$UNIT" /etc/systemd/system/webchatproxy-browser-login.service
mkdir -p /usr/local/cwpsrv/htdocs/resources/conf/web_servers/vhosts/nginx/php-fpm
install -o root -g root -m 0644 "$TEMPLATE" \
  /usr/local/cwpsrv/htdocs/resources/conf/web_servers/vhosts/nginx/webchatlogin.stpl
install -o root -g root -m 0644 "$TEMPLATE" \
  /usr/local/cwpsrv/htdocs/resources/conf/web_servers/vhosts/nginx/php-fpm/webchatlogin.stpl

if command -v htpasswd >/dev/null 2>&1; then
  HT="$(command -v htpasswd)"
elif [ -x /usr/local/apache/bin/htpasswd ]; then
  HT=/usr/local/apache/bin/htpasswd
else
  echo "htpasswd is required; install httpd-tools first" >&2
  exit 1
fi

if [ ! -s "$AUTH_FILE" ]; then
  "$HT" -c "$AUTH_FILE" login
else
  echo "Keeping existing $AUTH_FILE"
fi
chown root:nobody "$AUTH_FILE"
chmod 640 "$AUTH_FILE"

systemctl daemon-reload
systemctl restart webchatproxy-browser-login.service
echo "Browser login portal ready on 127.0.0.1:6080"
