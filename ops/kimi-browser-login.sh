#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
RUNTIME="$ROOT/runtime/kimi"
PYTHON="$ROOT/server/.venv-chatgpt/bin/python"

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo $0" >&2; exit 77; }
[ -x "$PYTHON" ] || { echo "ERROR: browser Python runtime is missing: $PYTHON" >&2; exit 78; }
mkdir -p "$RUNTIME"
chown agent:agent "$RUNTIME"

echo "Kimi opened in the shared noVNC browser. Complete login at https://chatgpt.agent.imobi.tools/vnc.html?autoconnect=1"

ROOT="$ROOT" "$PYTHON" - <<'PY'
import asyncio
import base64
import json
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path

import websockets

root = Path(os.environ["ROOT"])
runtime = root / "runtime" / "kimi"

def target_url():
    targets = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json"))
    for target in targets:
        if "kimi.com" in target.get("url", ""):
            return target["webSocketDebuggerUrl"]
    query = urllib.parse.quote("https://www.kimi.com", safe="")
    response = urllib.request.urlopen(urllib.request.Request(
        f"http://127.0.0.1:9222/json/new?{query}", method="PUT"))
    return json.load(response)["webSocketDebuggerUrl"]

def jwt_claims(value):
    if not isinstance(value, str) or value.count(".") != 2:
        return None
    try:
        payload = value.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return None

def candidates(value, key=""):
    if isinstance(value, str):
        claims = jwt_claims(value)
        if claims and claims.get("exp", 0) > time.time():
            yield key.lower(), value, claims
    elif isinstance(value, dict):
        for name, item in value.items():
            yield from candidates(item, f"{key}.{name}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from candidates(item, f"{key}[{index}]")

async def evaluate(ws, expression, message_id):
    await ws.send(json.dumps({"id": message_id, "method": "Runtime.evaluate", "params": {
        "expression": expression, "returnByValue": True
    }}))
    while True:
        message = json.loads(await ws.recv())
        if message.get("id") == message_id:
            return message.get("result", {}).get("result", {}).get("value")

async def extract():
    for _ in range(120):
        try:
            async with websockets.connect(target_url(), max_size=8 * 1024 * 1024) as ws:
                storage = await evaluate(ws, "JSON.stringify(Object.fromEntries(Object.entries(localStorage)))", 1)
                cookies = await evaluate(ws, "document.cookie", 2)
                values = []
                for key, raw in json.loads(storage or "{}").items():
                    values.append((key, raw))
                    try:
                        values.append((key, json.loads(raw)))
                    except Exception:
                        pass
                values.append(("cookie", cookies or ""))
                access = None
                refresh = None
                for key, value in values:
                    for name, token, claims in candidates(value, key):
                        token_type = str(claims.get("typ", "")).lower()
                        if not access and (token_type == "access" or "access" in name):
                            access = token
                        if not refresh and (token_type == "refresh" or "refresh" in name):
                            refresh = token
                if access:
                    (runtime / "access_token").write_text(access + "\n")
                    os.chmod(runtime / "access_token", 0o600)
                    if refresh:
                        (runtime / "refresh_token").write_text(refresh + "\n")
                        os.chmod(runtime / "refresh_token", 0o600)
                    print("Kimi access token captured from browser session.")
                    return
        except Exception:
            pass
        await asyncio.sleep(1)
    raise SystemExit("ERROR: Kimi login token was not found after 120 seconds")

asyncio.run(extract())
PY

chown agent:agent "$RUNTIME"/access_token "$RUNTIME"/refresh_token 2>/dev/null || true
systemctl restart webchatproxy-kimi-runtime.service
echo "Kimi runtime restarted with browser credentials."
