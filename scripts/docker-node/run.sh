#!/usr/bin/env bash
# tmex 节点容器的生命周期脚本。
#   scripts/docker-node/run.sh up      # 创建并启动
#   scripts/docker-node/run.sh down    # 停止并删除容器（加 -v 连数据卷一起删）
#   scripts/docker-node/run.sh logs    # 跟随日志
#   scripts/docker-node/run.sh shell   # 进容器
#   scripts/docker-node/run.sh status  # 容器 / healthz / install-meta 概况
#
# 可覆盖：TMEX_DOCKER_NAME、TMEX_DOCKER_IMAGE、TMEX_DOCKER_TAG、
#         TMEX_HTTP_PORT（默认 29883）、TMEX_PEER_HOST_PORT（默认 39001）、
#         TMEX_SITE_NAME、TMEX_BASE_URL。
set -euo pipefail

NAME="${TMEX_DOCKER_NAME:-tmex-node-docker}"
IMAGE="${TMEX_DOCKER_IMAGE:-tmex-node}"
TAG="${TMEX_DOCKER_TAG:-latest}"
HTTP_PORT="${TMEX_HTTP_PORT:-29883}"
# 网页/setup 接口默认只发布到宿主回环；要远程访问时显式设 TMEX_DOCKER_HTTP_BIND=0.0.0.0。
HTTP_BIND="${TMEX_DOCKER_HTTP_BIND:-127.0.0.1}"
PEER_PORT="${TMEX_PEER_HOST_PORT:-39001}"
VOL_OPT="${NAME}-opt"
VOL_DATA="${NAME}-data"

log() { printf '[docker-node] %s\n' "$*"; }

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
}

cmd_up() {
  if docker ps -a --format '{{.Names}}' | grep -qx "${NAME}"; then
    log "container ${NAME} already exists, starting it"
    docker start "${NAME}" >/dev/null
    return
  fi
  local env_args=()
  [[ -n "${TMEX_SITE_NAME:-}" ]] && env_args+=(-e "TMEX_SITE_NAME=${TMEX_SITE_NAME}")
  [[ -n "${TMEX_BASE_URL:-}" ]] && env_args+=(-e "TMEX_BASE_URL=${TMEX_BASE_URL}")
  log "creating ${NAME} from ${IMAGE}:${TAG} (http ${HTTP_BIND}:${HTTP_PORT}, peer ${PEER_PORT})"
  docker run -d \
    --name "${NAME}" \
    --restart unless-stopped \
    -v "${VOL_OPT}:/opt/tmex" \
    -v "${VOL_DATA}:/var/lib/tmex" \
    -p "${HTTP_BIND}:${HTTP_PORT}:9883" \
    -p "${PEER_PORT}:39001" \
    ${env_args[@]+"${env_args[@]}"} \
    "${IMAGE}:${TAG}" >/dev/null
  log "up. healthz: http://127.0.0.1:${HTTP_PORT}/healthz"
}

cmd_down() {
  docker rm -f "${NAME}" >/dev/null 2>&1 || true
  if [[ "${1:-}" == "-v" ]]; then
    docker volume rm "${VOL_OPT}" "${VOL_DATA}" >/dev/null 2>&1 || true
    log "removed ${NAME} and volumes ${VOL_OPT} / ${VOL_DATA}"
    return
  fi
  log "removed ${NAME} (volumes kept: ${VOL_OPT} / ${VOL_DATA})"
}

cmd_status() {
  docker ps -a --filter "name=^/${NAME}$" --format 'container: {{.Names}} {{.Status}} {{.Ports}}'
  curl -fsS -m 3 "http://127.0.0.1:${HTTP_PORT}/healthz" && printf '\n' || log "healthz not reachable"
  docker exec "${NAME}" cat /opt/tmex/install-meta.json 2>/dev/null || log "install-meta.json not found"
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down "${2:-}" ;;
  logs) docker logs -f "${NAME}" ;;
  shell) docker exec -it "${NAME}" bash ;;
  status) cmd_status ;;
  *) usage; exit 2 ;;
esac
