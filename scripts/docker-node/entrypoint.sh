#!/usr/bin/env bash
# vibeterm 节点容器 PID 1：首启用 vibeterm-cli 以 serviceMode=none 铺装 /opt/vibeterm，之后做轻量看护。
# 看护刻意「慢」：只有 vibeterm.pid 连续 20s 不存活且没有升级事务在跑时才拉起 run.sh，
# 否则会和就地升级器的 stop→start 间隙抢跑，第二个 run.sh 覆盖 vibeterm.pid 后因端口占用退出，
# 升级器的健康检查就会误判。
set -uo pipefail

INSTALL_DIR=/opt/vibeterm
DATA_DIR=/var/lib/vibeterm
PKG_DIR=/opt/vibeterm-pkg/package
BUN_PATH=/usr/local/bin/bun
NODE_PATH_BIN=/usr/local/bin/node
PID_FILE="${INSTALL_DIR}/vibeterm.pid"
LEGACY_PID_FILE="${INSTALL_DIR}/tmex.pid"
LOCK_FILE="${INSTALL_DIR}/upgrade.lock"
JOURNAL_FILE="${INSTALL_DIR}/upgrade-state.json"

GATEWAY_PORT_IN="${VIBETERM_GATEWAY_PORT:-9883}"
PEER_PORT_IN="${VIBETERM_PEER_PORT:-39001}"
SITE_NAME_IN="${VIBETERM_SITE_NAME:-docker-node}"
RESTART_DELAY_S="${VIBETERM_SUPERVISOR_DELAY:-20}"
TICK_S="${VIBETERM_SUPERVISOR_TICK:-2}"
JOURNAL_STALE_S="${VIBETERM_SUPERVISOR_JOURNAL_STALE:-900}"
DEMO_SESSION="${VIBETERM_DEMO_SESSION:-demo}"

log() { printf '[docker-node] %s\n' "$*"; }

# 改名前的包只有 bin/tmex.js。
pkg_bin() {
  local dir="$1"
  if [[ -f "${dir}/bin/vibeterm.js" ]]; then
    printf '%s' "${dir}/bin/vibeterm.js"
  else
    printf '%s' "${dir}/bin/tmex.js"
  fi
}

# ---------------------------------------------------------------- 状态探测

# 镜像可能由改名前的 CLI 铺装，pid 文件仍叫 tmex.pid。
resolve_pid_file() {
  if [[ -f "${PID_FILE}" ]]; then
    printf '%s' "${PID_FILE}"
  elif [[ -f "${LEGACY_PID_FILE}" ]]; then
    printf '%s' "${LEGACY_PID_FILE}"
  else
    return 1
  fi
}

read_runtime_pid() {
  local raw file
  file="$(resolve_pid_file)" || return 1
  raw="$(tr -d '\r\n' < "${file}" 2>/dev/null)" || return 1
  if [[ "${raw}" =~ ^[0-9]+$ ]]; then
    printf '%s' "${raw}"
    return 0
  fi
  if [[ "${raw}" =~ \"pid\"[[:space:]]*:[[:space:]]*([0-9]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

runtime_alive() {
  local pid
  pid="$(read_runtime_pid)" || return 1
  kill -0 "${pid}" 2>/dev/null
}

json_number() { sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p" "$1" | head -n1; }
json_string() { sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" | head -n1; }

# upgrade.lock 由 vibeterm upgrade 全程持有；持锁进程死了就是残留锁，不算占用。
lock_active() {
  local pid
  [[ -f "${LOCK_FILE}" ]] || return 1
  pid="$(json_number "${LOCK_FILE}" pid)"
  [[ -n "${pid}" ]] || return 0
  kill -0 "${pid}" 2>/dev/null
}

file_age_s() {
  local mtime now
  mtime="$(stat -c %Y "$1" 2>/dev/null)" || return 1
  now="$(date +%s)"
  printf '%s' "$((now - mtime))"
}

# upgrade-state.json 提交后不会被删除，只能按 phase 判断；再叠一层 mtime 兜底，
# 避免容器在升级中途被杀后留下的活跃 phase 把看护永久挡住。
journal_active() {
  local phase age
  [[ -f "${JOURNAL_FILE}" ]] || return 1
  phase="$(json_string "${JOURNAL_FILE}" phase)"
  case "${phase}" in
    '' | committed | aborted | rolled_back) return 1 ;;
  esac
  age="$(file_age_s "${JOURNAL_FILE}")" || return 0
  ((age < JOURNAL_STALE_S))
}

upgrade_active() { lock_active || journal_active; }

# ---------------------------------------------------------------- 首启铺装

require_clean_install_dir() {
  local leftovers
  leftovers="$(ls -A "${INSTALL_DIR}" 2>/dev/null)"
  [[ -z "${leftovers}" ]] && return 0
  log "FATAL: ${INSTALL_DIR} 非空但缺少 install-meta.json（上次 init 未完成）。"
  log "app.env 里的 VIBETERM_MASTER_KEY 与 ${DATA_DIR} 的库一一对应，这里不会自动重装。"
  log "请清空两个卷后重来：scripts/docker-node/run.sh down -v"
  exit 1
}

run_init() {
  require_clean_install_dir
  mkdir -p "${DATA_DIR}"
  log "first boot: installing vibeterm-cli into ${INSTALL_DIR} (serviceMode=none)"
  "${NODE_PATH_BIN}" "$(pkg_bin "${PKG_DIR}")" init \
    --no-interactive \
    --no-service \
    --role=standalone \
    --install-dir="${INSTALL_DIR}" \
    --host=0.0.0.0 \
    --port="${GATEWAY_PORT_IN}" \
    --db-path="${DATA_DIR}/vibeterm.db" \
    --peer-port="${PEER_PORT_IN}" \
    --autostart=false \
    --bun-path="${BUN_PATH}"
}

# init 写的 app.env 缺 VIBETERM_PEER_BIND_HOST，VIBETERM_SITE_NAME 固定为 vibeterm；
# 只在首启覆盖，之后 join / 用户手改的值一律保留。
set_env_key() {
  local key="$1" value="$2" file="${INSTALL_DIR}/app.env"
  if grep -q "^${key}=" "${file}" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${file}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${file}"
  fi
}

patch_first_boot_env() {
  set_env_key VIBETERM_SITE_NAME "${SITE_NAME_IN}"
  set_env_key VIBETERM_PEER_BIND_HOST 0.0.0.0
  if [[ -n "${VIBETERM_BASE_URL:-}" ]]; then
    set_env_key VIBETERM_BASE_URL "${VIBETERM_BASE_URL}"
  fi
  chmod 600 "${INSTALL_DIR}/app.env" 2>/dev/null || true
}

# ---------------------------------------------------------------- 进程控制

stop_runtime() {
  local pid
  pid="$(read_runtime_pid)" || return 0
  kill -0 "${pid}" 2>/dev/null || return 0
  log "stopping runtime pid=${pid}"
  kill -TERM "${pid}" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "${pid}" 2>/dev/null || return 0
    sleep 1
  done
  kill -KILL "${pid}" 2>/dev/null || true
}

# run.sh 自己把 $$ 写进 vibeterm.pid 后 exec bun，所以这里不需要额外记 pid。
start_runtime() {
  log "starting ${INSTALL_DIR}/run.sh"
  bash "${INSTALL_DIR}/run.sh" &
}

repair_if_interrupted() {
  journal_active || return 0
  log "found an interrupted upgrade transaction, running 'vibeterm upgrade --repair'"
  "${NODE_PATH_BIN}" "$(pkg_bin "${INSTALL_DIR}/current/cli")" upgrade --repair \
    --no-service --install-dir="${INSTALL_DIR}" --bun-path="${BUN_PATH}" || true
}

ensure_demo_session() {
  tmux has-session -t "${DEMO_SESSION}" 2>/dev/null && return 0
  tmux new-session -d -s "${DEMO_SESSION}" 2>/dev/null \
    && log "tmux session '${DEMO_SESSION}' created"
}

on_signal() {
  log "signal received, shutting down"
  stop_runtime
  exit 0
}

# ---------------------------------------------------------------- 看护循环

supervise() {
  local dead_since=0 now ticks=0
  while :; do
    if runtime_alive; then
      dead_since=0
      ((ticks % 30 == 0)) && ensure_demo_session
    elif upgrade_active; then
      dead_since=0
    else
      now="$(date +%s)"
      ((dead_since == 0)) && dead_since="${now}"
      if ((now - dead_since >= RESTART_DELAY_S)); then
        log "runtime down for $((now - dead_since))s and no upgrade in flight, restarting"
        start_runtime
        dead_since=0
      fi
    fi
    # PID 1 收养的孤儿进程靠这里回收：bash 在 wait 期间会把所有已退出的子进程收干净。
    sleep "${TICK_S}" &
    wait $! 2>/dev/null || true
    ticks=$((ticks + 1))
  done
}

main() {
  trap on_signal TERM INT
  mkdir -p "${DATA_DIR}"
  if [[ ! -f "${INSTALL_DIR}/install-meta.json" ]]; then
    run_init || exit 1
    stop_runtime
    patch_first_boot_env
    start_runtime
  else
    log "existing install detected (cliVersion=$(json_string "${INSTALL_DIR}/install-meta.json" cliVersion))"
    repair_if_interrupted
    runtime_alive || start_runtime
  fi
  ensure_demo_session
  supervise
}

main "$@"
