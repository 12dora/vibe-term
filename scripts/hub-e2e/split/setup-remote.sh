#!/usr/bin/env bash
# 在远端机上构建 tmex-e2e:split 并拉起 compose 项目 tmex-split（caddy + hub）。
# 不触碰 tmex-e2e 项目、nginx、80/443。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HUB_E2E="$(cd "${ROOT}/.." && pwd)"
COMPOSE=(docker compose -p tmex-split -f "${ROOT}/docker-compose.remote.yml")
IMAGE_NAME="tmex-e2e:split"
PLATFORM="linux/amd64"
TARBALL="${TMEX_TARBALL:-/root/tmex-e2e/tmex-cli-1.0.2.tgz}"
HUB_PUBLIC_URL="${TMEX_HUB_PUBLIC_URL:-https://ai.example.com:18443}"

log() { printf '[split-remote] %s\n' "$*"; }

wait_healthy() {
  local svc="$1"
  local n=0
  while (( n < 90 )); do
    local cid
    cid="$("${COMPOSE[@]}" ps -q "${svc}" 2>/dev/null || true)"
    if [[ -n "${cid}" ]] && docker exec "${cid}" curl -fsS -m 2 http://127.0.0.1:9883/healthz >/dev/null 2>&1; then
      return 0
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
  exit 0
fi

if [[ "${TMEX_E2E_SKIP_BUILD:-}" == "1" ]] && docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
  log "skipping build (TMEX_E2E_SKIP_BUILD=1, ${IMAGE_NAME} exists)"
else
  if [[ ! -f "${TARBALL}" ]]; then
    echo "tarball not found: ${TARBALL}" >&2
    exit 2
  fi
  mkdir -p "${HUB_E2E}/build"
  cp "${TARBALL}" "${HUB_E2E}/build/tmex-cli.tgz"
  log "building ${IMAGE_NAME} (--platform ${PLATFORM}) from ${TARBALL}"
  docker build --platform "${PLATFORM}" -t "${IMAGE_NAME}" -f "${HUB_E2E}/Dockerfile" "${HUB_E2E}"
fi

log "compose down (tmex-split only)"
"${COMPOSE[@]}" down -v --remove-orphans || true

log "compose up hub"
"${COMPOSE[@]}" up -d hub
wait_healthy hub

log "patch hub app.env public URL → ${HUB_PUBLIC_URL}"
docker exec tmex-split-hub bash -lc "
  set -euo pipefail
  f=/var/lib/tmex/app.env
  test -f \"\$f\"
  sed -i 's|^TMEX_BASE_URL=.*|TMEX_BASE_URL=${HUB_PUBLIC_URL}|' \"\$f\"
  sed -i 's|^TMEX_HUB_PUBLIC_URL=.*|TMEX_HUB_PUBLIC_URL=${HUB_PUBLIC_URL}|' \"\$f\"
  grep -q '^TMEX_TRUST_PROXY=' \"\$f\" && sed -i 's|^TMEX_TRUST_PROXY=.*|TMEX_TRUST_PROXY=true|' \"\$f\" || echo 'TMEX_TRUST_PROXY=true' >> \"\$f\"
  grep -q '^TMEX_PEER_BIND_HOST=' \"\$f\" && sed -i 's|^TMEX_PEER_BIND_HOST=.*|TMEX_PEER_BIND_HOST=0.0.0.0|' \"\$f\" || echo 'TMEX_PEER_BIND_HOST=0.0.0.0' >> \"\$f\"
  grep -E 'TMEX_BASE_URL|TMEX_HUB_PUBLIC_URL|TMEX_TRUST_PROXY|TMEX_PEER_BIND_HOST|TMEX_ROLES' \"\$f\"
"
docker restart tmex-split-hub
wait_healthy hub

log "compose up caddy (prefer 0.0.0.0:18443)"
caddy_ok=0
if "${COMPOSE[@]}" up -d caddy; then
  caddy_ok=1
else
  log "0.0.0.0:18443 被占用（不动 tmex-e2e）；改绑公网 IP 4.2.2.1:18443"
  bind_file="${ROOT}/.compose-bind.yml"
  sed 's/0.0.0.0:18443:443/4.2.2.1:18443:443/' "${ROOT}/docker-compose.remote.yml" > "${bind_file}"
  if docker compose -p tmex-split -f "${bind_file}" up -d caddy; then
    caddy_ok=1
  fi
fi
if [[ "${caddy_ok}" -ne 1 ]]; then
  echo "failed to bind 18443 (0.0.0.0 and 4.2.2.1)" >&2
  ss -lntp | grep 18443 || true
  docker ps --format '{{.Names}} {{.Ports}}' || true
  exit 1
fi
sleep 2
log "remote hub ready"
