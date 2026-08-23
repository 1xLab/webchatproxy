#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../.."
BASE_DIR="$(pwd -P)"
LOCK_FILE="$BASE_DIR/providers/deepseek/engine/UPSTREAM.lock"
VENDOR_DIR="${DEEPSEEK_VENDOR_DIR:-$BASE_DIR/.vendor/deepseek-web-api}"

repo="$(awk -F= '$1=="repo"{print substr($0,index($0,"=")+1)}' "$LOCK_FILE")"
pin="$(awk -F= '$1=="commit"{print $2}' "$LOCK_FILE")"
pm="$(awk -F= '$1=="package_manager"{print $2}' "$LOCK_FILE")"

[ -n "$repo" ] && [ -n "$pin" ] && [ -n "$pm" ] || { echo "ERROR: invalid $LOCK_FILE" >&2; exit 78; }
command -v git >/dev/null 2>&1 || { echo "ERROR: git is required" >&2; exit 78; }
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js 20+ is required" >&2; exit 78; }
command -v corepack >/dev/null 2>&1 || { echo "ERROR: corepack is required for pinned package manager" >&2; exit 78; }

node -e 'const [major]=process.versions.node.split(".").map(Number); if(major<20){console.error(`ERROR: Node.js 20+ required; found ${process.versions.node}`); process.exit(78)}'

mkdir -p "$(dirname "$VENDOR_DIR")"
if [ ! -d "$VENDOR_DIR/.git" ]; then
  rm -rf "$VENDOR_DIR"
  git init "$VENDOR_DIR"
  git -C "$VENDOR_DIR" remote add origin "$repo"
else
  current_origin="$(git -C "$VENDOR_DIR" remote get-url origin 2>/dev/null || true)"
  [ "$current_origin" = "$repo" ] || { echo "ERROR: unexpected DeepSeek upstream origin: $current_origin" >&2; exit 78; }
fi

git -C "$VENDOR_DIR" fetch --depth=1 origin "$pin"
git -C "$VENDOR_DIR" checkout --detach --force FETCH_HEAD
test "$(git -C "$VENDOR_DIR" rev-parse HEAD)" = "$pin" || { echo "ERROR: DeepSeek upstream pin mismatch" >&2; exit 78; }

pnpm_run() {
  corepack "$pm" "$@"
}

(
  cd "$VENDOR_DIR"
  pnpm_run install --frozen-lockfile
  pnpm_run typecheck
  pnpm_run lint
  pnpm_run test
  pnpm_run build
)

printf 'DeepSeek upstream installed and verified: %s\n' "$pin"
printf 'Vendor directory: %s\n' "$VENDOR_DIR"
