#!/usr/bin/env bash
# 手工铺装生产安装目录：生成/复用 app.env，再以 bun runtime 作为 PID 1。
set -euo pipefail

INSTALL_DIR=/opt/vibeterm
DATA_DIR=/var/lib/vibeterm
ENV_FILE="${DATA_DIR}/app.env"
LAYOUT_ENV="${INSTALL_DIR}/app.env"
INSTANCE="${VIBETERM_INSTANCE:-hub}"

mkdir -p "${DATA_DIR}/native"
[[ -L "${INSTALL_DIR}/native" ]] || rm -rf "${INSTALL_DIR}/native"

# app.env 必须落在 named volume 上，join 写回的 VIBETERM_HUB_URL / VIBETERM_ROLES 才能跨 stop/start 存活。
# 安装布局要求路径为 /opt/vibeterm/app.env，这里用 symlink 接到 volume。
ln -sfn "${ENV_FILE}" "${LAYOUT_ENV}"
ln -sfn "${DATA_DIR}/native" "${INSTALL_DIR}/native"

if [[ ! -f "${ENV_FILE}" ]]; then
  MASTER_KEY="$(openssl rand -base64 32)"
  HUB_URL=""
  HUB_PUBLIC_URL=""
  ROLES="standalone"
  BASE_URL="http://127.0.0.1:9883"
  TMUX_SOCKET="vibeterm-${INSTANCE}"

  case "${INSTANCE}" in
    hub)
      ROLES="hub,node"
      BASE_URL="https://hub.vibeterm.test"
      HUB_PUBLIC_URL="https://hub.vibeterm.test"
      TMUX_SOCKET="vibeterm-hub"
      ;;
    node-a)
      BASE_URL="https://entry.vibeterm.test"
      TMUX_SOCKET="vibeterm-node-a"
      ;;
    node-b)
      BASE_URL="http://127.0.0.1:9883"
      TMUX_SOCKET="vibeterm-node-b"
      ;;
    *)
      echo "unknown VIBETERM_INSTANCE=${INSTANCE}" >&2
      exit 1
      ;;
  esac

  cat > "${ENV_FILE}" <<EOF
NODE_ENV=production
VIBETERM_ROLES=${ROLES}
VIBETERM_MASTER_KEY=${MASTER_KEY}
GATEWAY_PORT=9883
VIBETERM_BIND_HOST=0.0.0.0
DATABASE_URL=${DATA_DIR}/vibeterm.db
VIBETERM_BASE_URL=${BASE_URL}
VIBETERM_SITE_NAME=vibeterm
VIBETERM_HUB_URL=${HUB_URL}
VIBETERM_HUB_PUBLIC_URL=${HUB_PUBLIC_URL}
VIBETERM_PEER_PORT=39001
VIBETERM_PEER_BIND_HOST=0.0.0.0
VIBETERM_STUN_SERVERS=${VIBETERM_E2E_STUN_SERVERS:-stun:stun.l.google.com:19302}
VIBETERM_TRUST_PROXY=true
VIBETERM_TMUX_SOCKET=${TMUX_SOCKET}
VIBETERM_NATIVE_DIR=${INSTALL_DIR}/native
EOF
  if [[ -n "${VIBETERM_E2E_TURN_URL:-}" ]]; then
    cat >> "${ENV_FILE}" <<EOF
VIBETERM_TURN_URL=${VIBETERM_E2E_TURN_URL}
VIBETERM_TURN_USERNAME=${VIBETERM_E2E_TURN_USERNAME:-vibeterm}
VIBETERM_TURN_CREDENTIAL=${VIBETERM_E2E_TURN_CREDENTIAL:-vibeterm-e2e}
EOF
  fi
  chmod 600 "${ENV_FILE}"
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

export VIBETERM_FE_DIST_DIR="${INSTALL_DIR}/resources/fe-dist"
export VIBETERM_MIGRATIONS_DIR="${INSTALL_DIR}/resources/gateway-drizzle"
export VIBETERM_NATIVE_DIR="${INSTALL_DIR}/native"
export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-/ca/ca.crt}"
export PATH="/usr/local/bin:${PATH}"

exec bun "${INSTALL_DIR}/runtime/server.js"
