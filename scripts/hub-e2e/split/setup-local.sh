#!/usr/bin/env bash
# 本机构建 tmex-e2e:split 并拉起 NAT 后的 node-a / node-b / driver。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HUB_E2E="$(cd "${ROOT}/.." && pwd)"
REPO_ROOT="$(cd "${HUB_E2E}/../.." && pwd)"
export TMEX_REPO_ROOT="${TMEX_REPO_ROOT:-${REPO_ROOT}}"
COMPOSE=(docker compose -p tmex-split-local -f "${ROOT}/docker-compose.local.yml")
IMAGE_NAME="tmex-e2e:split"
# 本机原生架构（Apple Silicon → linux/arm64，不走 qemu；x86 → linux/amd64），可用 TMEX_E2E_PLATFORM 覆盖
case "$(uname -m)" in arm64|aarch64) NATIVE_ARCH=arm64 ;; *) NATIVE_ARCH=amd64 ;; esac
PLATFORM="${TMEX_E2E_PLATFORM:-linux/${NATIVE_ARCH}}"
TARBALL="${TMEX_TARBALL:?set TMEX_TARBALL to the tmex-cli tarball}"

log() { printf '[split-local] %s\n' "$*"; }

wait_healthy() {
  local svc="$1"
  local n=0
  local restarted=0
  while (( n < 90 )); do
    local cid
    cid="$("${COMPOSE[@]}" ps -q "${svc}" 2>/dev/null || true)"
    if [[ -n "${cid}" ]]; then
      if docker exec "${cid}" curl -fsS -m 2 http://127.0.0.1:9883/healthz >/dev/null 2>&1; then
        return 0
      fi
      if (( n == 25 && restarted == 0 )); then
        log "restarting hung ${svc} (qemu/amd64 下 mesh 启动偶发卡住)"
        docker restart "${cid}" >/dev/null || true
        restarted=1
      fi
    fi
    sleep 2
    n=$((n + 1))
  done
  log "service ${svc} not healthy"
  docker logs "$("${COMPOSE[@]}" ps -q "${svc}" 2>/dev/null || true)" 2>&1 | tail -40 || true
  return 1
}

if [[ "${1:-}" == "down" ]]; then
  "${COMPOSE[@]}" down -v --remove-orphans || true
  docker network rm tmex-split-local_lan 2>/dev/null || true
  exit 0
fi

mkdir -p "${ROOT}/out"

if [[ "${TMEX_E2E_SKIP_BUILD:-}" == "1" ]] && docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
  log "skipping build (TMEX_E2E_SKIP_BUILD=1, ${IMAGE_NAME} exists)"
else
  if [[ ! -f "${TARBALL}" ]]; then
    echo "tarball not found: ${TARBALL}" >&2
    exit 2
  fi
  mkdir -p "${HUB_E2E}/build"
  cp "${TARBALL}" "${HUB_E2E}/build/tmex-cli.tgz"
  log "building ${IMAGE_NAME} (--platform ${PLATFORM})"
  docker build --platform "${PLATFORM}" -t "${IMAGE_NAME}" -f "${HUB_E2E}/Dockerfile" "${HUB_E2E}"
fi

log "compose down (tmex-split-local only)"
"${COMPOSE[@]}" down -v --remove-orphans || true
docker network rm tmex-split-local_lan 2>/dev/null || true

log "compose up node-a / node-b / driver (serialized)"
"${COMPOSE[@]}" up -d node-a
wait_healthy node-a
"${COMPOSE[@]}" up -d node-b
wait_healthy node-b
"${COMPOSE[@]}" up -d driver
sleep 1
log "local nodes ready"
