#!/usr/bin/env bash
# 手工铺装生产安装目录：生成/复用 app.env，再以 bun runtime 作为 PID 1。
set -euo pipefail

INSTALL_DIR=/opt/tmex
DATA_DIR=/var/lib/tmex
ENV_FILE="${DATA_DIR}/app.env"
LAYOUT_ENV="${INSTALL_DIR}/app.env"
INSTANCE="${TMEX_INSTANCE:-hub}"

mkdir -p "${DATA_DIR}/native"
[[ -L "${INSTALL_DIR}/native" ]] || rm -rf "${INSTALL_DIR}/native"

# app.env 必须落在 named volume 上，join 写回的 TMEX_HUB_URL / TMEX_ROLES 才能跨 stop/start 存活。
# 安装布局要求路径为 /opt/tmex/app.env，这里用 symlink 接到 volume。
ln -sfn "${ENV_FILE}" "${LAYOUT_ENV}"
ln -sfn "${DATA_DIR}/native" "${INSTALL_DIR}/native"

if [[ ! -f "${ENV_FILE}" ]]; then
  MASTER_KEY="$(openssl rand -base64 32)"
  HUB_URL=""
  HUB_PUBLIC_URL=""
  ROLES="standalone"
  BASE_URL="http://127.0.0.1:9883"
  TMUX_SOCKET="tmex-${INSTANCE}"

  case "${INSTANCE}" in
    hub)
      ROLES="hub,node"
      BASE_URL="https://hub.tmex.test"
      HUB_PUBLIC_URL="https://hub.tmex.test"
      TMUX_SOCKET="tmex-hub"
      ;;
    node-a)
      BASE_URL="https://entry.tmex.test"
      TMUX_SOCKET="tmex-node-a"
      ;;
    node-b)
      BASE_URL="http://127.0.0.1:9883"
      TMUX_SOCKET="tmex-node-b"
      ;;
    *)
      echo "unknown TMEX_INSTANCE=${INSTANCE}" >&2
      exit 1
      ;;
  esac

  cat > "${ENV_FILE}" <<EOF
NODE_ENV=production
TMEX_ROLES=${ROLES}
TMEX_MASTER_KEY=${MASTER_KEY}
GATEWAY_PORT=9883
TMEX_BIND_HOST=0.0.0.0
DATABASE_URL=${DATA_DIR}/tmex.db
TMEX_BASE_URL=${BASE_URL}
TMEX_SITE_NAME=tmex
TMEX_HUB_URL=${HUB_URL}
TMEX_HUB_PUBLIC_URL=${HUB_PUBLIC_URL}
TMEX_PEER_PORT=39001
TMEX_PEER_BIND_HOST=0.0.0.0
TMEX_STUN_SERVERS=${TMEX_E2E_STUN_SERVERS:-stun:stun.l.google.com:19302}
TMEX_TRUST_PROXY=true
TMEX_TMUX_SOCKET=${TMUX_SOCKET}
TMEX_NATIVE_DIR=${INSTALL_DIR}/native
EOF
  chmod 600 "${ENV_FILE}"
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

export TMEX_FE_DIST_DIR="${INSTALL_DIR}/resources/fe-dist"
export TMEX_MIGRATIONS_DIR="${INSTALL_DIR}/resources/gateway-drizzle"
export TMEX_NATIVE_DIR="${INSTALL_DIR}/native"
export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-/ca/ca.crt}"
export PATH="/usr/local/bin:${PATH}"

exec bun "${INSTALL_DIR}/runtime/server.js"
