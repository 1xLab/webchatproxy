#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../.."
BASE_DIR="$(pwd -P)"
LOCK_FILE="$BASE_DIR/providers/kimi/engine/UPSTREAM.lock"
VENDOR_DIR="${KIMI_VENDOR_DIR:-$BASE_DIR/.vendor/kimi-free-api}"

repo="$(awk -F= '$1=="repo"{print substr($0,index($0,"=")+1)}' "$LOCK_FILE")"
pin="$(awk -F= '$1=="commit"{print $2}' "$LOCK_FILE")"

[ -n "$repo" ] && [ -n "$pin" ] || { echo "ERROR: invalid $LOCK_FILE" >&2; exit 78; }
command -v git >/dev/null 2>&1 || { echo "ERROR: git is required" >&2; exit 78; }
command -v go >/dev/null 2>&1 || { echo "ERROR: Go 1.21+ is required" >&2; exit 78; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required" >&2; exit 78; }

go version | awk '{print $3}' | sed 's/^go//' | awk -F. '{ if (($1+0)<1 || (($1+0)==1 && ($2+0)<21)) exit 78 }'

mkdir -p "$(dirname "$VENDOR_DIR")"
if [ ! -d "$VENDOR_DIR/.git" ]; then
  rm -rf "$VENDOR_DIR"
  git init "$VENDOR_DIR"
  git -C "$VENDOR_DIR" remote add origin "$repo"
else
  current_origin="$(git -C "$VENDOR_DIR" remote get-url origin 2>/dev/null || true)"
  [ "$current_origin" = "$repo" ] || { echo "ERROR: unexpected Kimi upstream origin: $current_origin" >&2; exit 78; }
fi

git -C "$VENDOR_DIR" fetch --depth=1 origin "$pin"
git -C "$VENDOR_DIR" checkout --detach --force FETCH_HEAD
git -C "$VENDOR_DIR" clean -fdx
test "$(git -C "$VENDOR_DIR" rev-parse HEAD)" = "$pin" || { echo "ERROR: Kimi vendor checkout is not at pinned commit $pin" >&2; exit 78; }

PATCHES_DIR="$BASE_DIR/providers/kimi/engine/patches"
if [ -d "$PATCHES_DIR" ]; then
  for patch_file in "$PATCHES_DIR"/*.patch; do
    [ -e "$patch_file" ] || continue
    echo "Applying Kimi source patch: $(basename "$patch_file")"
    git -C "$VENDOR_DIR" apply --check "$patch_file" || { echo "ERROR: patch check failed: $patch_file" >&2; exit 78; }
    git -C "$VENDOR_DIR" apply "$patch_file"
  done
fi

cp "$BASE_DIR/providers/kimi/engine/refresh.go" "$VENDOR_DIR/refresh.go"
cp "$BASE_DIR/providers/kimi/engine/native.go" "$VENDOR_DIR/native.go"
python3 - "$VENDOR_DIR/main.go" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()

token_needle = '"Bearer "+accessToken'
token_count = source.count(token_needle)
if token_count != 3:
    raise SystemExit(f"ERROR: expected exactly 3 Kimi access-token call sites, found {token_count}")
source = source.replace(token_needle, '"Bearer "+getAccessToken()')

router_needle = '''    case path == "/refresh-models" && r.Method == http.MethodPost:\n        handleRefreshModels(w, r)\n    default:\n'''
router_replacement = '''    case path == "/refresh-models" && r.Method == http.MethodPost:\n        handleRefreshModels(w, r)\n    case handleKimiNativeRoute(w, r):\n        return\n    default:\n'''
router_count = source.count(router_needle)
if router_count != 1:
    raise SystemExit(f"ERROR: expected exactly one Kimi router insertion point, found {router_count}")
source = source.replace(router_needle, router_replacement)

path.write_text(source)
PY

(
  cd "$VENDOR_DIR"
  gofmt -w main.go refresh.go native.go
  go vet main.go refresh.go native.go
  go build -trimpath -ldflags '-s -w' -o kimi-proxy main.go refresh.go native.go
)

test -x "$VENDOR_DIR/kimi-proxy"
printf 'Kimi upstream installed and verified: %s\n' "$pin"
printf 'Vendor directory: %s\n' "$VENDOR_DIR"
