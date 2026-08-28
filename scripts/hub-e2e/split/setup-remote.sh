#!/usr/bin/env bash
# 在远端机上构建 tmex-e2e:split 并拉起 compose 项目 tmex-split（caddy + hub）。
# 不触碰 tmex-e2e 项目、nginx、80/443。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HUB_E2E="$(cd "${ROOT}/.." && pwd)"
REMOTE_SUDO="${TMEX_E2E_REMOTE_SUDO:-}"
if [[ -n "${REMOTE_SUDO}" ]]; then
  DOCKER=("${REMOTE_SUDO}" --preserve-env docker)
else
  DOCKER=(docker)
fi
COMPOSE=("${DOCKER[@]}" compose -p tmex-split -f "${ROOT}/docker-compose.remote.yml")
IMAGE_NAME="tmex-e2e:split"
PLATFORM="linux/amd64"
export TMEX_E2E_HUB_HOST="${TMEX_E2E_HUB_HOST:-ai.example.com}"
export TMEX_E2E_HUB_IP="${TMEX_E2E_HUB_IP:-4.2.2.1}"
export TMEX_E2E_HUB_PORT="${TMEX_E2E_HUB_PORT:-18443}"
export TMEX_E2E_REMOTE_DIR="${TMEX_E2E_REMOTE_DIR:-/root/tmex-e2e}"
export TMEX_E2E_TLS_MODE="${TMEX_E2E_TLS_MODE:-letsencrypt}"
export TMEX_E2E_TURN_EXTERNAL_IP="${TMEX_E2E_TURN_EXTERNAL_IP:-${TMEX_E2E_HUB_IP}}"
TARBALL="${TMEX_TARBALL:-${TMEX_E2E_REMOTE_DIR}/tmex-cli-1.0.2.tgz}"
HUB_PUBLIC_URL="${TMEX_HUB_PUBLIC_URL:-https://${TMEX_E2E_HUB_HOST}:${TMEX_E2E_HUB_PORT}}"
if [[ "${TMEX_E2E_TLS_MODE}" == "private-ca" ]]; then
  export TMEX_E2E_TLS_CERT="${TMEX_E2E_TLS_CERT:-${TMEX_E2E_REMOTE_DIR}/repo/scripts/hub-e2e/ca/hub.crt}"
  export TMEX_E2E_TLS_KEY="${TMEX_E2E_TLS_KEY:-${TMEX_E2E_REMOTE_DIR}/repo/scripts/hub-e2e/ca/hub.key}"
  export TMEX_E2E_CA_CRT="${TMEX_E2E_CA_CRT:-${TMEX_E2E_REMOTE_DIR}/repo/scripts/hub-e2e/ca/ca.crt}"
  export TMEX_E2E_NODE_CA_CERTS="${TMEX_E2E_NODE_CA_CERTS:-/ca/ca.crt}"
else
  export TMEX_E2E_TLS_CERT="${TMEX_E2E_TLS_CERT:-${TMEX_E2E_REMOTE_DIR}/certs/fullchain.pem}"
  export TMEX_E2E_TLS_KEY="${TMEX_E2E_TLS_KEY:-${TMEX_E2E_REMOTE_DIR}/certs/privkey.pem}"
  export TMEX_E2E_CA_CRT="${TMEX_E2E_CA_CRT:-/etc/ssl/certs/ca-certificates.crt}"
  export TMEX_E2E_NODE_CA_CERTS="${TMEX_E2E_NODE_CA_CERTS:-/etc/ssl/certs/ca-certificates.crt}"
fi

log() { printf '[split-remote] %s\n' "$*"; }

render_caddyfile() {
  sed -e "s/__HUB_HOST__/${TMEX_E2E_HUB_HOST}/g" -e "s/__HUB_IP__/${TMEX_E2E_HUB_IP}/g" -e "s/__HUB_PORT__/${TMEX_E2E_HUB_PORT}/g" \
    "${ROOT}/Caddyfile" > "${ROOT}/Caddyfile.runtime"
  export TMEX_E2E_CADDYFILE="${ROOT}/Caddyfile.runtime"
}

wait_healthy() {
  local svc="$1"
  local n=0
  local max=$(( ${TMEX_E2E_HEALTH_TIMEOUT:-600} / 2 ))
  while (( n < max )); do
    local cid
    cid="$("${COMPOSE[@]}" ps -q "${svc}" 2>/dev/null || true)"
    if [[ -n "${cid}" ]] && "${DOCKER[@]}" exec "${cid}" curl -fsS -m 2 http://127.0.0.1:9883/healthz >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    n=$((n + 1))
  done
  log "service ${svc} not healthy"
  "${DOCKER[@]}" logs "$("${COMPOSE[@]}" ps -q "${svc}" 2>/dev/null || true)" 2>&1 | tail -40 || true
  return 1
}

if [[ "${1:-}" == "down" ]]; then
  "${COMPOSE[@]}" down -v --remove-orphans || true
  exit 0
fi

if [[ "${TMEX_E2E_SKIP_BUILD:-}" == "1" ]] && "${DOCKER[@]}" image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
  log "skipping build (TMEX_E2E_SKIP_BUILD=1, ${IMAGE_NAME} exists)"
else
  if [[ ! -f "${TARBALL}" ]]; then
    echo "tarball not found: ${TARBALL}" >&2
    exit 2
  fi
  mkdir -p "${HUB_E2E}/build"
  cp "${TARBALL}" "${HUB_E2E}/build/tmex-cli.tgz"
  log "building ${IMAGE_NAME} (--platform ${PLATFORM}) from ${TARBALL}"
  "${DOCKER[@]}" build --platform "${PLATFORM}" -t "${IMAGE_NAME}" -f "${HUB_E2E}/Dockerfile" "${HUB_E2E}"
fi

render_caddyfile

log "compose down (tmex-split only)"
"${COMPOSE[@]}" down -v --remove-orphans || true

log "compose up hub"
"${COMPOSE[@]}" up -d hub
if [[ -n "${TMEX_E2E_TURN_URL:-}" ]]; then
  log "compose up turn (coturn, host network :3478 + 49160-49200/udp)"
  "${COMPOSE[@]}" up -d turn || log "turn failed to start (image coturn/coturn:latest missing?) — continuing without TURN"
fi
wait_healthy hub

log "patch hub app.env public URL → ${HUB_PUBLIC_URL}"
"${DOCKER[@]}" exec tmex-split-hub bash -lc "
  set -euo pipefail
  f=/var/lib/tmex/app.env
  test -f \"\$f\"
  sed -i 's|^TMEX_BASE_URL=.*|TMEX_BASE_URL=${HUB_PUBLIC_URL}|' \"\$f\"
  sed -i 's|^TMEX_HUB_PUBLIC_URL=.*|TMEX_HUB_PUBLIC_URL=${HUB_PUBLIC_URL}|' \"\$f\"
  grep -q '^TMEX_TRUST_PROXY=' \"\$f\" && sed -i 's|^TMEX_TRUST_PROXY=.*|TMEX_TRUST_PROXY=true|' \"\$f\" || echo 'TMEX_TRUST_PROXY=true' >> \"\$f\"
  grep -q '^TMEX_PEER_BIND_HOST=' \"\$f\" && sed -i 's|^TMEX_PEER_BIND_HOST=.*|TMEX_PEER_BIND_HOST=0.0.0.0|' \"\$f\" || echo 'TMEX_PEER_BIND_HOST=0.0.0.0' >> \"\$f\"
  grep -E 'TMEX_BASE_URL|TMEX_HUB_PUBLIC_URL|TMEX_TRUST_PROXY|TMEX_PEER_BIND_HOST|TMEX_ROLES' \"\$f\"
"
"${DOCKER[@]}" restart tmex-split-hub
wait_healthy hub

log "compose up caddy (prefer 0.0.0.0:${TMEX_E2E_HUB_PORT})"
caddy_ok=0
if "${COMPOSE[@]}" up -d caddy; then
  caddy_ok=1
else
  log "0.0.0.0:${TMEX_E2E_HUB_PORT} 被占用（不动 tmex-e2e）；改绑公网 IP ${TMEX_E2E_HUB_IP}:${TMEX_E2E_HUB_PORT}"
  bind_file="${ROOT}/.compose-bind.yml"
  sed "s/0.0.0.0:/${TMEX_E2E_HUB_IP}:/" "${ROOT}/docker-compose.remote.yml" > "${bind_file}"
  if "${DOCKER[@]}" compose -p tmex-split -f "${bind_file}" up -d caddy; then
    caddy_ok=1
  fi
fi
if [[ "${caddy_ok}" -ne 1 ]]; then
  echo "failed to bind ${TMEX_E2E_HUB_PORT} (0.0.0.0 and ${TMEX_E2E_HUB_IP})" >&2
  ss -lntp | grep "${TMEX_E2E_HUB_PORT}" || true
  "${DOCKER[@]}" ps --format '{{.Names}} {{.Ports}}' || true
  exit 1
fi
sleep 2
log "remote hub ready"
