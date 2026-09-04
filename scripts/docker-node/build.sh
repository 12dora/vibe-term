#!/usr/bin/env bash
# 构建可升级的 tmex 节点镜像。
#   scripts/docker-node/build.sh                     # 先在仓库根 bun run build，再 npm pack
#   TMEX_TARBALL=/path/tmex-cli-1.1.25.tgz scripts/docker-node/build.sh   # 跳过构建
# 可选：把 build/bun-linux-{aarch64,x64}.zip 预下载到构建上下文，镜像构建就不联网装 bun。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${ROOT}/../.." && pwd)"
IMAGE="${TMEX_DOCKER_IMAGE:-tmex-node}"
PLATFORM="${TMEX_DOCKER_PLATFORM:-}"

log() { printf '[docker-node build] %s\n' "$*" >&2; }

resolve_tarball() {
  if [[ -n "${TMEX_TARBALL:-}" ]]; then
    if [[ ! -f "${TMEX_TARBALL}" ]]; then
      echo "tarball not found: ${TMEX_TARBALL}" >&2
      exit 2
    fi
    printf '%s' "${TMEX_TARBALL}"
    return
  fi
  log "building the workspace (bun run build)"
  (cd "${REPO_ROOT}" && bun run build) >&2
  rm -f "${ROOT}/build"/tmex-cli-*.tgz
  log "npm pack tmex-cli"
  (cd "${REPO_ROOT}/packages/app" && npm pack --pack-destination "${ROOT}/build") >&2
  local packed
  packed="$(ls -t "${ROOT}/build"/tmex-cli-*.tgz 2>/dev/null | head -n1)"
  if [[ -z "${packed}" ]]; then
    echo "npm pack produced no tarball" >&2
    exit 1
  fi
  printf '%s' "${packed}"
}

package_version() {
  local name version
  name="$(basename "$1")"
  version="$(printf '%s' "${name}" | sed -n 's/^tmex-cli-\(.*\)\.tgz$/\1/p')"
  if [[ -z "${version}" ]]; then
    version="$(node -p "require('${REPO_ROOT}/packages/app/package.json').version")"
  fi
  printf '%s' "${version}"
}

TARBALL="$(resolve_tarball)"
VERSION="$(package_version "${TARBALL}")"
log "tarball=${TARBALL} version=${VERSION}"

mkdir -p "${ROOT}/build"
if [[ "$(cd "$(dirname "${TARBALL}")" && pwd)/$(basename "${TARBALL}")" != "${ROOT}/build/tmex-cli.tgz" ]]; then
  cp -f "${TARBALL}" "${ROOT}/build/tmex-cli.tgz"
fi

BUILD_ARGS=(--build-arg "TMEX_TARBALL=build/tmex-cli.tgz")
[[ -n "${PLATFORM}" ]] && BUILD_ARGS+=(--platform "${PLATFORM}")

docker build "${BUILD_ARGS[@]}" \
  -t "${IMAGE}:${VERSION}" \
  -t "${IMAGE}:latest" \
  "${ROOT}"

log "built ${IMAGE}:${VERSION} (also tagged ${IMAGE}:latest)"
