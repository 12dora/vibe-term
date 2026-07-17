#!/bin/bash
# linux managed gateway smoke：Apple container 内启动产物，宿主 curl 探测。
# 用法：bash scripts/smoke-managed-linux.sh <linux-arm64|linux-x64>
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:?usage: $0 <linux-arm64|linux-x64>}"
DIST_DIR="$PWD/dist-managed"
BIN="$DIST_DIR/tmex-gateway-managed-$TARGET"
[ -f "$BIN" ] || { echo "artifact missing: $BIN" >&2; exit 1; }

case "$TARGET" in
  linux-arm64) ARCH="arm64" ;;
  linux-x64) ARCH="amd64" ;;
esac

PORT=$((39000 + RANDOM % 2000))
NAME="tmex-smoke-$TARGET-$RANDOM"
IMAGE="ubuntu:24.04"

echo "[smoke-linux] starting $NAME ($TARGET, port $PORT)"
container run --rm -d --name "$NAME" --arch "$ARCH" \
  -v "$DIST_DIR":/mnt:ro \
  -e GATEWAY_PORT="$PORT" -e TMEX_BIND_HOST=0.0.0.0 \
  -e DATABASE_URL=/tmp/gateway.db -e TMEX_MASTER_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
  -e NODE_ENV=production \
  -p "$PORT:$PORT" "$IMAGE" /mnt/"$(basename "$BIN")" > /dev/null

cleanup() { container stop "$NAME" > /dev/null 2>&1 || true; }
trap cleanup EXIT

ok=false
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" > /dev/null 2>&1; then ok=true; break; fi
  sleep 1
done
[ "$ok" = true ] || { echo "[smoke-linux] health timeout"; container logs "$NAME" | tail -20; exit 1; }

info=$(curl -fsS "http://127.0.0.1:$PORT/api/system/info")
echo "$info" | grep -q '"managementMode":"companion-cli"' || { echo "[smoke-linux] bad managementMode: $info"; exit 1; }
echo "$info" | grep -q '"canSelfUpdate":false' || { echo "[smoke-linux] canSelfUpdate not false: $info"; exit 1; }

code=$(curl -s -o /tmp/smoke-update.json -w '%{http_code}' "http://127.0.0.1:$PORT/api/system/update-check")
[ "$code" = 403 ] || { echo "[smoke-linux] update-check not 403: $code"; exit 1; }
grep -q managed_externally /tmp/smoke-update.json || { echo "[smoke-linux] update-check body wrong: $(cat /tmp/smoke-update.json)"; exit 1; }

code=$(curl -s -o /tmp/smoke-upgrade.json -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"version":"9.9.9"}' "http://127.0.0.1:$PORT/api/system/upgrade")
[ "$code" = 403 ] || { echo "[smoke-linux] upgrade not 403: $code"; exit 1; }
grep -q managed_externally /tmp/smoke-upgrade.json || { echo "[smoke-linux] upgrade body wrong"; exit 1; }

echo "[smoke-linux] $TARGET PASS (port $PORT)"
