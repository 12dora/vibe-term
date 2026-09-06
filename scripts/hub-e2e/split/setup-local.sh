#!/usr/bin/env bash
# 本机构建 vibeterm-e2e:split 并拉起 NAT 后的 node-a / node-b / driver。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HUB_E2E="$(cd "${ROOT}/.." && pwd)"
REPO_ROOT="$(cd "${HUB_E2E}/../.." && pwd)"
export VIBETERM_REPO_ROOT="${VIBETERM_REPO_ROOT:-${REPO_ROOT}}"
export VIBETERM_E2E_HUB_HOST="${VIBETERM_E2E_HUB_HOST:-ai.example.com}"
export VIBETERM_E2E_HUB_IP="${VIBETERM_E2E_HUB_IP:-4.2.2.1}"
export VIBETERM_E2E_NODE_CA_CERTS="${VIBETERM_E2E_NODE_CA_CERTS:-/etc/ssl/certs/ca-certificates.crt}"
COMPOSE=(docker compose -p vibeterm-split-local -f "${ROOT}/docker-compose.local.yml")
IMAGE_NAME="vibeterm-e2e:split"
# 本机原生架构（Apple Silicon → linux/arm64，不走 qemu；x86 → linux/amd64），可用 VIBETERM_E2E_PLATFORM 覆盖
case "$(uname -m)" in arm64|aarch64) NATIVE_ARCH=arm64 ;; *) NATIVE_ARCH=amd64 ;; esac
PLATFORM="${VIBETERM_E2E_PLATFORM:-linux/${NATIVE_ARCH}}"
TARBALL="${VIBETERM_TARBALL:?set VIBETERM_TARBALL to the vibeterm-cli tarball}"

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
  docker network rm vibeterm-split-local_lan 2>/dev/null || true
  exit 0
fi

mkdir -p "${ROOT}/out"

if [[ "${VIBETERM_E2E_SKIP_BUILD:-}" == "1" ]] && docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
  log "skipping build (VIBETERM_E2E_SKIP_BUILD=1, ${IMAGE_NAME} exists)"
else
  if [[ ! -f "${TARBALL}" ]]; then
    echo "tarball not found: ${TARBALL}" >&2
    exit 2
  fi
  mkdir -p "${HUB_E2E}/build"
  cp "${TARBALL}" "${HUB_E2E}/build/vibeterm-cli.tgz"
  log "building ${IMAGE_NAME} (--platform ${PLATFORM})"
  docker build --platform "${PLATFORM}" -t "${IMAGE_NAME}" -f "${HUB_E2E}/Dockerfile" "${HUB_E2E}"
fi

log "compose down (vibeterm-split-local only)"
"${COMPOSE[@]}" down -v --remove-orphans || true
docker network rm vibeterm-split-local_lan 2>/dev/null || true

log "compose up node-a / node-b / driver (serialized)"
"${COMPOSE[@]}" up -d node-a
wait_healthy node-a
"${COMPOSE[@]}" up -d node-b
wait_healthy node-b
"${COMPOSE[@]}" up -d driver
sleep 1
log "local nodes ready"
