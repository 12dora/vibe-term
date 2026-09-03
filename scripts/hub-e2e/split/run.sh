#!/usr/bin/env bash
# 分体拓扑 e2e：远端公网 hub × 本地 NAT node。
#   scripts/hub-e2e/split/run.sh
#   scripts/hub-e2e/split/run.sh down
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HUB_E2E="$(cd "${ROOT}/.." && pwd)"
REPO_ROOT="$(cd "${HUB_E2E}/../.." && pwd)"
export TMEX_REPO_ROOT="${TMEX_REPO_ROOT:-${REPO_ROOT}}"
LOCAL_COMPOSE=(docker compose -p tmex-split-local -f "${ROOT}/docker-compose.local.yml")
# RSSH：一个可执行文件，把参数当远端命令执行（例如封装 sshpass/ssh 的脚本）；凭据不入库。
# RSYNC_SSH：rsync -e 使用的 ssh 命令（同样由调用方提供，可含 sshpass 包装），例如 RSYNC_SSH=/path/to/ssh-wrap。
RSYNC_SSH="${RSYNC_SSH:?set RSYNC_SSH to an ssh command for rsync -e (e.g. a wrapper script that adds -p/-o/sshpass)}"
RSSH="${RSSH:?set RSSH to an ssh wrapper script, e.g. RSSH=/path/to/rssh (runs: rssh '<remote command>')}"
HUB_HOST="${TMEX_E2E_HUB_HOST:-ai.example.com}"
HUB_IP="${TMEX_E2E_HUB_IP:-4.2.2.1}"
HUB_PORT="${TMEX_E2E_HUB_PORT:-18443}"
HUB_PUBLIC_URL="${TMEX_HUB_PUBLIC_URL:-https://${HUB_HOST}:${HUB_PORT}}"
REMOTE_USER="${TMEX_E2E_REMOTE_USER:-root}"
REMOTE_DIR="${TMEX_E2E_REMOTE_DIR:-/root/tmex-e2e}"
if [[ -n "${TMEX_E2E_REMOTE_SUDO+x}" ]]; then
  REMOTE_SUDO="${TMEX_E2E_REMOTE_SUDO}"
elif [[ "${REMOTE_USER}" != "root" ]]; then
  REMOTE_SUDO="sudo"
else
  REMOTE_SUDO=""
fi
if [[ -n "${REMOTE_SUDO}" ]]; then
  REMOTE_DOCKER="${REMOTE_SUDO} docker"
else
  REMOTE_DOCKER="docker"
fi
TLS_MODE="${TMEX_E2E_TLS_MODE:-letsencrypt}"
if [[ "${TLS_MODE}" != "letsencrypt" && "${TLS_MODE}" != "private-ca" ]]; then
  echo "TMEX_E2E_TLS_MODE must be letsencrypt or private-ca (got ${TLS_MODE})" >&2
  exit 2
fi
REMOTE_TARBALL="${TMEX_E2E_REMOTE_TARBALL:-${REMOTE_DIR}/tmex-cli-1.0.2.tgz}"
export TMEX_E2E_HUB_HOST="${HUB_HOST}"
export TMEX_E2E_HUB_IP="${HUB_IP}"
export TMEX_E2E_HUB_PORT="${HUB_PORT}"
export TMEX_E2E_REMOTE_DIR="${REMOTE_DIR}"
export TMEX_E2E_TLS_MODE="${TLS_MODE}"
export TMEX_E2E_TURN_EXTERNAL_IP="${TMEX_E2E_TURN_EXTERNAL_IP:-${HUB_IP}}"
if [[ "${TLS_MODE}" == "private-ca" ]]; then
  NODE_CA_CERTS="${TMEX_E2E_NODE_CA_CERTS:-/ca/ca.crt}"
  export TMEX_E2E_TLS_CERT="${TMEX_E2E_TLS_CERT:-${REMOTE_DIR}/repo/scripts/hub-e2e/ca/hub.crt}"
  export TMEX_E2E_TLS_KEY="${TMEX_E2E_TLS_KEY:-${REMOTE_DIR}/repo/scripts/hub-e2e/ca/hub.key}"
  export TMEX_E2E_CA_CRT="${TMEX_E2E_CA_CRT:-${REMOTE_DIR}/repo/scripts/hub-e2e/ca/ca.crt}"
else
  NODE_CA_CERTS="${TMEX_E2E_NODE_CA_CERTS:-/etc/ssl/certs/ca-certificates.crt}"
  export TMEX_E2E_TLS_CERT="${TMEX_E2E_TLS_CERT:-${REMOTE_DIR}/certs/fullchain.pem}"
  export TMEX_E2E_TLS_KEY="${TMEX_E2E_TLS_KEY:-${REMOTE_DIR}/certs/privkey.pem}"
  export TMEX_E2E_CA_CRT="${TMEX_E2E_CA_CRT:-/etc/ssl/certs/ca-certificates.crt}"
fi
export TMEX_E2E_NODE_CA_CERTS="${NODE_CA_CERTS}"
USER_NAME="${TMEX_E2E_USER:-alice}"
PASSWORD="${TMEX_E2E_PASSWORD:-TmexE2e!alice-2026}"
OUT="${ROOT}/out"
IMAGE_NAME="tmex-e2e:split"
TARBALL="${TMEX_TARBALL:?set TMEX_TARBALL to the tmex-cli tarball used to build the local image}"
FAILS=0
declare -a REPORT_ROWS=()

log() { printf '[split-e2e] %s\n' "$*"; }
pass() { log "PASS $1"; REPORT_ROWS+=("| $1 | PASS | ${2:-} |"); }
fail() { log "FAIL $1"; REPORT_ROWS+=("| $1 | FAIL | ${2:-$1} |"); FAILS=$((FAILS + 1)); }
skip() { log "SKIP $1"; REPORT_ROWS+=("| $1 | SKIP | ${2:-$1} |"); }
rssh() { "${RSSH}" "$@"; }
rssh_docker() { rssh "${REMOTE_DOCKER} $*"; }
DIRECT_DROP_MODE=""
DIRECT_DC=0
DIRECT_SKIPPED=0
LAN_NETEM_ON=0
LAN_NETEM_IFACE_A=""
LAN_NETEM_IFACE_B=""
LAN_NET="tmex-split-local_lan"

usage() {
  cat <<'EOF'
Usage:
  scripts/hub-e2e/split/run.sh
  scripts/hub-e2e/split/run.sh down
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" == "down" ]]; then
  "${LOCAL_COMPOSE[@]}" down -v --remove-orphans || true
  docker network rm tmex-split-local_lan 2>/dev/null || true
  rssh_docker "compose -p tmex-split -f ${REMOTE_DIR}/repo/scripts/hub-e2e/split/docker-compose.remote.yml down -v --remove-orphans" || true
  exit 0
fi

mkdir -p "${OUT}"
: > "${OUT}/run.log"
exec > >(tee -a "${OUT}/run.log") 2>&1

echo "需在远端放行入站 TCP ${HUB_PORT}（必需，hub HTTPS）与 TCP 39001（可选，hub peer 口）——包括云安全组/面板防火墙/ufw"

wait_local_healthy() {
  local svc="$1"
  local n=0
  local restarted=0
  while (( n < 90 )); do
    local cid
    cid="$("${LOCAL_COMPOSE[@]}" ps -q "${svc}" 2>/dev/null || true)"
    if [[ -n "${cid}" ]]; then
      if docker exec "${cid}" curl -fsS -m 2 http://127.0.0.1:9883/healthz >/dev/null 2>&1; then
        return 0
      fi
      if (( n == 25 && restarted == 0 )); then
        log "restarting hung ${svc}"
        docker restart "${cid}" >/dev/null || true
        restarted=1
      fi
    fi
    sleep 2
    n=$((n + 1))
  done
  log "service ${svc} not healthy"
  docker logs "$("${LOCAL_COMPOSE[@]}" ps -q "${svc}")" 2>&1 | tail -40 || true
  return 1
}

wait_remote_hub() {
  local n=0
  local max=$(( ${TMEX_E2E_HEALTH_TIMEOUT:-600} / 2 ))
  while (( n < max )); do
    if rssh_docker "exec tmex-split-hub curl -fsS -m 2 http://127.0.0.1:9883/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    n=$((n + 1))
  done
  rssh_docker "logs tmex-split-hub 2>&1 | tail -40" || true
  return 1
}

driver() {
  local name="$1"
  local bundled="${HUB_E2E}/driver-dist/${name%.ts}.js"
  if [[ -f "${bundled}" ]]; then
    docker exec -w /workspace tmex-split-driver \
      bun "/workspace/scripts/hub-e2e/driver-dist/${name%.ts}.js" "${@:2}"
  else
    docker exec -w /workspace tmex-split-driver \
      bun "/workspace/scripts/hub-e2e/driver/${name}" "${@:2}"
  fi
}

split_bun() {
  docker exec -w /workspace tmex-split-driver bun "$@"
}

curl_hub() {
  if [[ "${TLS_MODE}" == "private-ca" ]]; then
    docker exec tmex-split-driver curl -fsS --cacert /ca/ca.crt "$@"
  else
    docker exec tmex-split-driver curl -fsS "$@"
  fi
}

dump_logs() {
  mkdir -p "${OUT}"
  "${LOCAL_COMPOSE[@]}" logs --no-color node-a > "${OUT}/node-a.log" 2>&1 || true
  "${LOCAL_COMPOSE[@]}" logs --no-color node-b > "${OUT}/node-b.log" 2>&1 || true
  "${LOCAL_COMPOSE[@]}" logs --no-color driver > "${OUT}/driver.log" 2>&1 || true
  rssh_docker "logs --tail 400 tmex-split-hub" > "${OUT}/hub.log" 2>&1 || true
  rssh_docker "logs --tail 200 tmex-split-caddy" > "${OUT}/caddy.log" 2>&1 || true
}

dump_rtc_logs() {
  local peer="${1:-hub}"
  docker logs tmex-split-node-a 2>&1 | grep -E '\[mesh\]\[rtc\]' | tail -120 > "${OUT}/direct-logs-node-a.txt" || true
  if [[ ! -s "${OUT}/direct-logs-node-a.txt" ]]; then
    docker logs tmex-split-node-a 2>&1 | grep -iE 'rtc|datachannel|ice failed|ws-secure' | tail -120 > "${OUT}/direct-logs-node-a.txt" || true
  fi
  if [[ "${peer}" == "node-b" ]]; then
    docker logs tmex-split-node-b 2>&1 | grep -E '\[mesh\]\[rtc\]' | tail -120 > "${OUT}/direct-logs-node-b.txt" || true
    if [[ ! -s "${OUT}/direct-logs-node-b.txt" ]]; then
      docker logs tmex-split-node-b 2>&1 | grep -iE 'rtc|datachannel|ice failed|ws-secure' | tail -120 > "${OUT}/direct-logs-node-b.txt" || true
    fi
  else
    rssh_docker "logs tmex-split-hub 2>&1 | grep -E '\\[mesh\\]\\[rtc\\]' | tail -120" > "${OUT}/direct-logs-hub.txt" || true
    if [[ ! -s "${OUT}/direct-logs-hub.txt" ]]; then
      rssh_docker "logs tmex-split-hub 2>&1 | grep -iE 'rtc|datachannel|ice failed|ws-secure' | tail -120" > "${OUT}/direct-logs-hub.txt" || true
    fi
  fi
}

rtc_evidence() {
  local peer="${1:-hub}"
  local a p
  local peer_file="${OUT}/direct-logs-hub.txt"
  local peer_label=hub
  if [[ "${peer}" == "node-b" ]]; then
    peer_file="${OUT}/direct-logs-node-b.txt"
    peer_label=node-b
  fi
  a="$(grep -iE 'ice failed|datachannel|fallback' "${OUT}/direct-logs-node-a.txt" 2>/dev/null | tail -1 | tr '|' '/' || true)"
  p="$(grep -iE 'ice failed|datachannel|fallback' "${peer_file}" 2>/dev/null | tail -1 | tr '|' '/' || true)"
  printf 'node-a=%s; %s=%s' "${a:-none}" "${peer_label}" "${p:-none}"
}

ensure_udp_drop_tool() {
  if docker exec tmex-split-node-a bash -lc 'command -v iptables >/dev/null'; then
    DIRECT_DROP_MODE=iptables
    log "udp drop mode=iptables"
    return
  fi
  if docker exec tmex-split-node-a bash -lc 'command -v nft >/dev/null'; then
    DIRECT_DROP_MODE=nft
    log "udp drop mode=nft"
    return
  fi
  log "iptables/nft absent in image; attempting apt-get install iptables"
  docker exec tmex-split-node-a bash -lc \
    'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables' \
    >/dev/null 2>&1 || true
  if docker exec tmex-split-node-a bash -lc 'command -v iptables >/dev/null'; then
    DIRECT_DROP_MODE=iptables
    log "udp drop mode=iptables (installed at runtime)"
    return
  fi
  DIRECT_DROP_MODE=network
  log "udp drop mode=network (docker network disconnect/connect nat-a; also bounces hub uplink)"
}

drop_direct_udp() {
  case "${DIRECT_DROP_MODE}" in
    iptables)
      docker exec tmex-split-node-a iptables -I OUTPUT -p udp -j DROP
      ;;
    nft)
      docker exec tmex-split-node-a bash -lc \
        'nft add table ip tmex_e2e 2>/dev/null || true; nft "add chain ip tmex_e2e output { type filter hook output priority 0 ; }"; nft add rule ip tmex_e2e output udp drop'
      ;;
    network)
      docker network disconnect tmex-split-local_nat-a tmex-split-node-a || true
      sleep 1
      docker network connect tmex-split-local_nat-a tmex-split-node-a || true
      ;;
    *)
      log "udp drop skipped (no mode)"
      return 1
      ;;
  esac
}

undrop_direct_udp() {
  case "${DIRECT_DROP_MODE}" in
    iptables)
      docker exec tmex-split-node-a iptables -D OUTPUT -p udp -j DROP || true
      ;;
    nft)
      docker exec tmex-split-node-a nft delete table ip tmex_e2e || true
      ;;
    network)
      docker network connect tmex-split-local_nat-a tmex-split-node-a 2>/dev/null || true
      ;;
  esac
}

lan_container_ip() {
  local container="$1"
  local ip
  ip="$(docker inspect -f "{{range \$name, \$net := .NetworkSettings.Networks}}{{if eq \$name \"${LAN_NET}\"}}{{\$net.IPAddress}}{{end}}{{end}}" "${container}" 2>/dev/null || true)"
  if [[ -z "${ip}" || "${ip}" == "<no value>" ]]; then
    printf ''
    return 0
  fi
  printf '%s' "${ip}"
}

lan_iface_for_ip() {
  local container="$1"
  local ip="$2"
  local iface
  iface="$(docker exec "${container}" ip -4 -o addr 2>/dev/null \
    | awk -v want="${ip}" '{ split($4, a, "/"); if (a[1] == want) { print $2; exit } }' \
    || true)"
  iface="${iface%%@*}"
  printf '%s' "${iface}"
}

lookup_lan_iface() {
  local container="$1"
  local cached="${2:-}"
  local ip iface
  ip="$(lan_container_ip "${container}")"
  if [[ -n "${ip}" ]]; then
    iface="$(lan_iface_for_ip "${container}" "${ip}")"
    if [[ -n "${iface}" ]]; then
      printf '%s %s' "${iface}" "${ip}"
      return 0
    fi
  fi
  if [[ -n "${cached}" ]]; then
    printf '%s' "${cached}"
    return 0
  fi
  return 1
}

wait_lan_iface() {
  local container="$1"
  local n=0
  local got=""
  while (( n < 15 )); do
    got="$(lookup_lan_iface "${container}" "")" || true
    if [[ -n "${got}" && -n "${got%% *}" ]]; then
      printf '%s' "${got}"
      return 0
    fi
    sleep 1
    n=$((n + 1))
  done
  return 1
}

apply_lan_netem_on() {
  local container="$1"
  local resolved="" iface="" ip=""
  local -a args
  read -r -a args <<< "${TMEX_E2E_LAN_NETEM:-}"
  if ((${#args[@]} == 0)); then
    log "lan netem: empty TMEX_E2E_LAN_NETEM"
    return 1
  fi
  if ! docker exec "${container}" bash -lc 'command -v tc >/dev/null && command -v ip >/dev/null'; then
    log "lan netem: ${container} missing ip/tc (rebuild image with iproute2)"
    return 1
  fi
  resolved="$(wait_lan_iface "${container}")" || true
  iface="${resolved%% *}"
  ip="${resolved#* }"
  if [[ -z "${iface}" ]]; then
    log "lan netem: ${container} no iface on ${LAN_NET}"
    return 1
  fi
  docker exec "${container}" tc qdisc del dev "${iface}" root >/dev/null 2>&1 || true
  if ! docker exec "${container}" tc qdisc add dev "${iface}" root netem "${args[@]}"; then
    log "lan netem: tc qdisc add failed on ${container} dev=${iface}"
    return 1
  fi
  case "${container}" in
    tmex-split-node-a) LAN_NETEM_IFACE_A="${iface}" ;;
    tmex-split-node-b) LAN_NETEM_IFACE_B="${iface}" ;;
  esac
  log "lan netem: ${container} dev=${iface} ip=${ip} netem ${TMEX_E2E_LAN_NETEM:-}"
  log "lan netem qdisc ${container}: $(docker exec "${container}" tc qdisc show dev "${iface}" 2>/dev/null | tr '\n' ' ' | tr '|' '/' || true)"
}

apply_lan_netem() {
  if [[ -z "${TMEX_E2E_LAN_NETEM:-}" ]]; then
    return 0
  fi
  local rc=0
  apply_lan_netem_on tmex-split-node-a || rc=1
  apply_lan_netem_on tmex-split-node-b || rc=1
  if [[ "${rc}" -eq 0 ]]; then
    LAN_NETEM_ON=1
  fi
  return "${rc}"
}

clear_lan_netem_on() {
  local container="$1"
  local cached="${2:-}"
  local resolved="" iface=""
  resolved="$(lookup_lan_iface "${container}" "${cached}")" || true
  iface="${resolved%% *}"
  if [[ -z "${iface}" ]]; then
    return 0
  fi
  docker exec "${container}" tc qdisc del dev "${iface}" root >/dev/null 2>&1 || true
  log "lan netem: cleared ${container} dev=${iface}"
}

clear_lan_netem() {
  if [[ -z "${TMEX_E2E_LAN_NETEM:-}" ]]; then
    return 0
  fi
  clear_lan_netem_on tmex-split-node-a "${LAN_NETEM_IFACE_A:-}"
  clear_lan_netem_on tmex-split-node-b "${LAN_NETEM_IFACE_B:-}"
  LAN_NETEM_ON=0
}

show_lan_qdisc() {
  local container="$1"
  local cached="${2:-}"
  local resolved="" iface="" q=""
  resolved="$(lookup_lan_iface "${container}" "${cached}")" || true
  iface="${resolved%% *}"
  if [[ -z "${iface}" ]]; then
    printf 'none'
    return 0
  fi
  q="$(docker exec "${container}" tc qdisc show dev "${iface}" 2>/dev/null | tr '\n' ' ' | tr '|' '/' || true)"
  q="${q%"${q##*[![:space:]]}"}"
  printf '%s' "${q:-none}"
}

lan_netem_qdisc_evidence() {
  printf 'qdisc node-a[%s]=%s; node-b[%s]=%s' \
    "${LAN_NETEM_IFACE_A:-?}" \
    "$(show_lan_qdisc tmex-split-node-a "${LAN_NETEM_IFACE_A:-}")" \
    "${LAN_NETEM_IFACE_B:-?}" \
    "$(show_lan_qdisc tmex-split-node-b "${LAN_NETEM_IFACE_B:-}")"
}

write_report() {
  local rows=""
  if ((${#REPORT_ROWS[@]} > 0)); then
    rows="$(printf '%s\n' "${REPORT_ROWS[@]}")"
  fi
  cat > "${OUT}/report.md" <<EOF
# tmex split hub-e2e report

- date: $(date -u +%Y-%m-%dT%H:%M:%SZ)
- image: ${IMAGE_NAME}
- tarball: ${TARBALL}
- hub: ${HUB_PUBLIC_URL}
- hub host/ip: ${HUB_HOST} / ${HUB_IP}
- tls: ${TLS_MODE}
- remote: ${REMOTE_USER}@${HUB_IP}:${REMOTE_DIR}
- lan netem: ${TMEX_E2E_LAN_NETEM:-off}

| scenario | result | evidence |
|---|---|---|
${rows}
EOF
}

cleanup_on_exit() {
  undrop_direct_udp 2>/dev/null || true
  clear_lan_netem 2>/dev/null || true
  dump_logs
  write_report
}
trap cleanup_on_exit EXIT

wait_file_match() {
  local file="$1"
  local regex="$2"
  local timeout_s="${3:-30}"
  local n=0
  while (( n < timeout_s )); do
    if [[ -f "${file}" ]] && grep -E "${regex}" "${file}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    n=$((n + 1))
  done
  return 1
}

kill_enroll() {
  rssh_docker "exec tmex-split-hub bash -lc 'pkill -f \"cli-auth.js enroll\" || true; pkill -f \"enroll --ttl\" || true'" || true
}

enroll_and_join() {
  local node_name="$1"
  local log_file="${OUT}/enroll-${node_name}.log"
  : > "${log_file}"
  kill_enroll
  rssh_docker "exec tmex-split-hub bash -lc 'rm -f /tmp/enroll.log'"
  rssh_docker "exec -d -e TMEX_PASSWORD='${PASSWORD}' tmex-split-hub bash -lc 'nohup stdbuf -oL bun /opt/tmex/runtime/cli-auth.js enroll --ttl 10m --install-dir /opt/tmex >/tmp/enroll.log 2>&1'"
  local n=0
  while (( n < 45 )); do
    rssh_docker "exec tmex-split-hub cat /tmp/enroll.log" > "${log_file}" 2>/dev/null || true
    if grep -E 'join token: [A-Za-z0-9_-]+' "${log_file}" >/dev/null 2>&1; then
      break
    fi
    sleep 1
    n=$((n + 1))
  done
  if ! grep -E 'join token: [A-Za-z0-9_-]+' "${log_file}" >/dev/null 2>&1; then
    kill_enroll
    echo "enroll did not print token; log:" >&2
    cat "${log_file}" >&2 || true
    return 1
  fi
  local token
  token="$(grep -E 'join token: ' "${log_file}" | tail -n1 | awk '{print $3}')"
  if [[ ${#token} -lt 80 ]]; then
    kill_enroll
    echo "token too short: ${token}" >&2
    return 1
  fi
  log "got enroll token for ${node_name} (len=${#token})"

  "${LOCAL_COMPOSE[@]}" stop "${node_name}"
  set +e
  "${LOCAL_COMPOSE[@]}" run --rm --no-deps --entrypoint bash "${node_name}" -lc "
    set +e
    export NODE_EXTRA_CA_CERTS=${NODE_CA_CERTS}
    rm -f /opt/tmex/app.env
    cp /var/lib/tmex/app.env /opt/tmex/app.env
    mkdir -p /opt/tmex/native /var/lib/tmex/native
    bun /opt/tmex/runtime/cli-auth.js hub join ${HUB_PUBLIC_URL} --token '${token}' --name '${node_name}' --install-dir /opt/tmex --no-restart
    join_code=\$?
    echo JOIN_EXIT=\$join_code
    cp /opt/tmex/app.env /var/lib/tmex/app.env
    grep -E '^TMEX_HUB_URL=' /var/lib/tmex/app.env || true
    grep -E '^TMEX_ROLES=' /var/lib/tmex/app.env || true
    grep -q 'TMEX_HUB_URL=${HUB_PUBLIC_URL}' /var/lib/tmex/app.env || exit 20
    grep -q 'TMEX_ROLES=node' /var/lib/tmex/app.env || exit 21
    exit 0
  " | tee "${OUT}/join-${node_name}.log"
  local join_ok=${PIPESTATUS[0]}
  set -e
  if [[ "${join_ok}" -ne 0 ]]; then
    kill_enroll
    echo "hub join did not persist TMEX_HUB_URL/TMEX_ROLES for ${node_name}" >&2
    return 1
  fi

  n=0
  while (( n < 60 )); do
    rssh_docker "exec tmex-split-hub cat /tmp/enroll.log" > "${log_file}" 2>/dev/null || true
    if grep -E 'node admitted' "${log_file}" >/dev/null 2>&1; then
      break
    fi
    sleep 1
    n=$((n + 1))
  done
  if ! grep -E 'node admitted' "${log_file}" >/dev/null 2>&1; then
    log "warning: enroll log did not show 'node admitted' for ${node_name}; continuing after join state write"
  fi
  kill_enroll
  "${LOCAL_COMPOSE[@]}" start "${node_name}"
  wait_local_healthy "${node_name}"
}

jread() {
  local file="$1"
  local expr="$2"
  docker exec tmex-split-driver bun -e "const j=await Bun.file('${file}').json(); process.stdout.write(String(${expr})||'')"
}

sync_clocks() {
  # 只检查不改时钟：hub 校验 delegation 的 issued_at 容差为 DELEGATION_CLOCK_SKEW_MS=60s，
  # 远端 NTP 不同步会得到 DELEGATION_ISSUED_IN_FUTURE。时钟应由远端 NTP 修正（timedatectl set-ntp true）。
  local hub_now driver_now
  hub_now="$(rssh 'date -u +%s')"
  driver_now="$(docker exec tmex-split-driver date -u +%s)"
  local delta=$(( driver_now - hub_now ))
  if (( delta < 0 )); then delta=$(( -delta )); fi
  log "clock skew hub↔driver = ${delta}s"
  if (( delta > 30 )); then
    log "WARNING: clock skew ${delta}s > 30s；请在远端启用 NTP（timedatectl set-ntp true），否则登录会报 DELEGATION_ISSUED_IN_FUTURE"
    return 1
  fi
  return 0
}

# 直连/TURN 依赖 UDP 能到公网 hub 机；macOS 上 TUN 代理会把 UDP 吞掉，绕过办法是加一条主机路由。
preflight_udp() {
  local target_port="${1:-3478}"
  local probe
  probe="$(docker exec tmex-split-driver bun /workspace/scripts/hub-e2e/split/udp-probe.ts "${HUB_IP}" "${target_port}" 2>/dev/null || true)"
  if [[ "${probe}" == reply* ]]; then
    log "udp preflight: ${HUB_IP}:${target_port} reachable (${probe})"
    return 0
  fi
  log "WARNING: udp preflight: no STUN/TURN reply from ${HUB_IP}:${target_port}; direct path (D/H/I) will stay on relay"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    local iface gateway
    iface="$(route -n get "${HUB_IP}" 2>/dev/null | awk '/interface:/ {print $2}')"
    gateway="$(netstat -rn -f inet 2>/dev/null | awk '$1 == "default" && $NF !~ /utun/ {print $2; exit}')"
    if [[ "${iface}" == utun* && -n "${gateway}" ]]; then
      log "default route goes through ${iface} (TUN proxy). Bypass it with a host route:"
      log "    sudo route -n add -host ${HUB_IP} ${gateway}      # remove later: sudo route -n delete -host ${HUB_IP}"
      if sudo -n route -n add -host "${HUB_IP}" "${gateway}" >/dev/null 2>&1; then
        log "host route added (passwordless sudo); re-probing"
        preflight_udp "${target_port}"
        return $?
      fi
    fi
  fi
  return 1
}

ensure_private_ca() {
  local ca_dir="${HUB_E2E}/ca"
  if [[ ! -f "${ca_dir}/ca.crt" || ! -f "${ca_dir}/hub.crt" || ! -f "${ca_dir}/hub.key" ]]; then
    echo "private-ca mode requires ${ca_dir}/{ca.crt,hub.crt,hub.key}; run scripts/hub-e2e/gen-ca.sh" >&2
    exit 2
  fi
  if openssl x509 -in "${ca_dir}/hub.crt" -noout -text | grep -q "DNS:${HUB_HOST}"; then
    return 0
  fi
  log "hub.crt SAN missing ${HUB_HOST}; reissuing leaf cert from existing CA"
  openssl genrsa -out "${ca_dir}/hub.key" 2048
  openssl req -new -key "${ca_dir}/hub.key" -subj "/CN=${HUB_HOST}" -out "${ca_dir}/hub.csr"
  cat > "${ca_dir}/hub.ext" <<EOF
subjectAltName=DNS:${HUB_HOST},DNS:hub.tmex.test,DNS:entry.tmex.test
extendedKeyUsage=serverAuth
keyUsage=digitalSignature,keyEncipherment
basicConstraints=CA:FALSE
EOF
  openssl x509 -req -in "${ca_dir}/hub.csr" -CA "${ca_dir}/ca.crt" -CAkey "${ca_dir}/ca.key" \
    -CAcreateserial -out "${ca_dir}/hub.crt" -days 825 -sha256 -extfile "${ca_dir}/hub.ext"
  rm -f "${ca_dir}/hub.csr"
  chmod 644 "${ca_dir}/ca.crt" "${ca_dir}/hub.crt"
  chmod 600 "${ca_dir}/hub.key"
}

# ---------- setup ----------
if [[ "${TLS_MODE}" == "private-ca" ]]; then
  ensure_private_ca
fi

log "rsync harness to remote (${REMOTE_USER}@${HUB_IP}:${REMOTE_DIR})"
rssh "mkdir -p ${REMOTE_DIR}/repo/scripts/hub-e2e"
RSYNC_EXCLUDES=(--exclude out --exclude build)
if [[ "${TLS_MODE}" != "private-ca" ]]; then
  RSYNC_EXCLUDES+=(--exclude ca)
fi
rsync -az -e "${RSYNC_SSH}" "${RSYNC_EXCLUDES[@]}" \
  "${HUB_E2E}/" "${REMOTE_USER}@${HUB_IP}:${REMOTE_DIR}/repo/scripts/hub-e2e/"

log "setup remote hub"
rssh "TMEX_E2E_TURN_URL='${TMEX_E2E_TURN_URL:-}' TMEX_E2E_TURN_USERNAME='${TMEX_E2E_TURN_USERNAME:-tmex}' TMEX_E2E_TURN_CREDENTIAL='${TMEX_E2E_TURN_CREDENTIAL:-tmex-e2e}' TMEX_E2E_TURN_EXTERNAL_IP='${TMEX_E2E_TURN_EXTERNAL_IP}' TMEX_E2E_SKIP_BUILD=${TMEX_E2E_SKIP_BUILD:-1} TMEX_TARBALL='${REMOTE_TARBALL}' TMEX_E2E_HUB_HOST='${HUB_HOST}' TMEX_E2E_HUB_IP='${HUB_IP}' TMEX_E2E_HUB_PORT='${HUB_PORT}' TMEX_HUB_PUBLIC_URL='${HUB_PUBLIC_URL}' TMEX_E2E_REMOTE_DIR='${REMOTE_DIR}' TMEX_E2E_REMOTE_SUDO='${REMOTE_SUDO}' TMEX_E2E_TLS_MODE='${TLS_MODE}' TMEX_E2E_TLS_CERT='${TMEX_E2E_TLS_CERT}' TMEX_E2E_TLS_KEY='${TMEX_E2E_TLS_KEY}' TMEX_E2E_CA_CRT='${TMEX_E2E_CA_CRT}' TMEX_E2E_NODE_CA_CERTS='${NODE_CA_CERTS}' bash ${REMOTE_DIR}/repo/scripts/hub-e2e/split/setup-remote.sh"

log "setup local nodes"
TMEX_TARBALL="${TARBALL}" TMEX_E2E_SKIP_BUILD="${TMEX_E2E_SKIP_BUILD:-1}" \
  TMEX_E2E_HUB_HOST="${HUB_HOST}" TMEX_E2E_HUB_IP="${HUB_IP}" \
  TMEX_E2E_NODE_CA_CERTS="${NODE_CA_CERTS}" \
  bash "${ROOT}/setup-local.sh"

sync_clocks || log "clock sync imperfect, login may hit DELEGATION_ISSUED_IN_FUTURE"
preflight_udp "${TMEX_E2E_UDP_PROBE_PORT:-3478}" || true

# ---------- A ----------
set +e
health_json="$(curl_hub "${HUB_PUBLIC_URL}/healthz")"
health_rc=$?
set -e
if [[ "${health_rc}" -eq 0 ]] && echo "${health_json}" | grep -q '"status":"ok"'; then
  pass "A0 hub /healthz via public HTTPS"
else
  fail "A0 hub /healthz via public HTTPS (rc=${health_rc} body=${health_json})"
fi

set +e
add_out="$(rssh_docker "exec -e TMEX_PASSWORD='${PASSWORD}' tmex-split-hub bun /opt/tmex/runtime/cli-auth.js hub user add ${USER_NAME} --install-dir /opt/tmex" 2>&1)"
add_rc=$?
set -e
printf '%s\n' "${add_out}" | tee "${OUT}/hub-user-add.log"
if [[ "${add_rc}" -eq 0 ]] && echo "${add_out}" | grep -q "user ${USER_NAME} created"; then
  pass "A0b hub user add ${USER_NAME}"
else
  fail "A0b hub user add ${USER_NAME} (rc=${add_rc})"
fi

set +e
mode_json="$(curl_hub "${HUB_PUBLIC_URL}/api/auth/mode")"
mode_rc=$?
set -e
printf '%s\n' "${mode_json}" | tee "${OUT}/auth-mode.json"
if [[ "${mode_rc}" -eq 0 ]] \
  && echo "${mode_json}" | grep -q '"rootEpoch"' \
  && echo "${mode_json}" | grep -q '"rootPublicKey"' \
  && echo "${mode_json}" | grep -q "${HUB_HOST}"; then
  pass "A0c /api/auth/mode mesh fields"
else
  fail "A0c /api/auth/mode mesh fields (body=${mode_json})"
fi

if enroll_and_join node-a && enroll_and_join node-b; then
  pass "A1 enroll+join node-a and node-b over internet"
else
  fail "A1 enroll+join node-a and node-b over internet"
fi

set +e
driver login.ts --base-url "${HUB_PUBLIC_URL}" --username "${USER_NAME}" --password "${PASSWORD}" --out /out/cookies-hub.json
login_hub_rc=$?
set -e
if [[ "${login_hub_rc}" -eq 0 ]]; then
  pass "A2 login hub entry ${HUB_PUBLIC_URL}"
else
  fail "A2 login hub entry ${HUB_PUBLIC_URL}"
fi

set +e
driver nodes.ts wait-hub-online --base-url "${HUB_PUBLIC_URL}" --cookie-file /out/cookies-hub.json --names node-a,node-b --timeout 120000
hub_online_rc=$?
set -e
driver nodes.ts hub-list --base-url "${HUB_PUBLIC_URL}" --cookie-file /out/cookies-hub.json > "${OUT}/hub-nodes.json" || true
if [[ "${hub_online_rc}" -eq 0 ]]; then
  pass "A3 /api/hub/nodes both online"
else
  fail "A3 /api/hub/nodes both online"
fi

NODE_A_ID="$(jread /out/hub-nodes.json '(j.nodes??[]).find(x=>x.name==="node-a")?.id' || true)"
NODE_B_ID="$(jread /out/hub-nodes.json '(j.nodes??[]).find(x=>x.name==="node-b")?.id' || true)"
log "node-a=${NODE_A_ID} node-b=${NODE_B_ID}"

if [[ -n "${NODE_A_ID}" && -n "${NODE_B_ID}" ]]; then
  pass "A4 resolve node ids"
else
  fail "A4 resolve node ids"
fi

ensure_local() {
  local svc="$1"
  if docker exec "tmex-split-${svc}" curl -fsS -m 3 http://127.0.0.1:9883/healthz >/dev/null 2>&1; then
    return 0
  fi
  log "restarting wedged ${svc}"
  docker restart "tmex-split-${svc}" >/dev/null || true
  wait_local_healthy "${svc}"
}

login_via_hub() {
  local nid="$1"
  local svc="$2"
  local i=0
  local rc=1
  set +e
  while (( i < 5 )); do
    ensure_local "${svc}"
    driver login.ts --base-url "${HUB_PUBLIC_URL}" --username "${USER_NAME}" --password "${PASSWORD}" \
      --target-node-id "${nid}" --out /out/cookies-hub.json
    rc=$?
    if [[ "${rc}" -eq 0 ]]; then
      set -e
      return 0
    fi
    log "hub→${svc} login failed (rc=${rc}), restart and retry ${i}"
    docker restart "tmex-split-${svc}" >/dev/null || true
    wait_local_healthy "${svc}"
    driver nodes.ts wait-hub-online --base-url "${HUB_PUBLIC_URL}" --cookie-file /out/cookies-hub.json \
      --names "${svc}" --timeout 60000 || true
    i=$((i + 1))
    sleep 2
  done
  set -e
  return 1
}

if [[ -z "${NODE_A_ID}" || -z "${NODE_B_ID}" || "${login_hub_rc}" -ne 0 ]]; then
  skip "A6–A8 skipped (missing hub login or node ids)"
  skip "B skipped (missing hub login or node ids)"
  skip "C skipped (missing hub login or node ids)"
  skip "E skipped (missing hub login or node ids)"
  skip "D skipped (missing hub login or node ids)"
  skip "L skipped (missing hub login or node ids)"
  skip "H skipped (missing hub login or node ids)"
  skip "I skipped (missing hub login or node ids)"
  skip "F skipped (missing hub login or node ids)"
  skip "G skipped (missing hub login or node ids)"
  write_report
  log "report at ${OUT}/report.md"
  exit 1
fi

ensure_local node-a
ensure_local node-b
docker exec tmex-split-node-a bash -lc '
  tmux -L tmex-node-a kill-session -t e2e-a 2>/dev/null || true
  tmux -L tmex-node-a new-session -d -s e2e-a "sh -lc '"'"'echo READY; exec sh'"'"'"
'
docker exec tmex-split-node-b bash -lc '
  mkdir -p /e2e
  echo "hello-e2e" > /e2e/marker.txt
  tmux -L tmex-node-b kill-session -t e2e-b 2>/dev/null || true
  tmux -L tmex-node-b new-session -d -s e2e-b "sh -lc '"'"'echo READY; exec sh'"'"'"
'

set +e
login_via_hub "${NODE_A_ID}" node-a
login_a_rc=$?
set -e
if [[ "${login_a_rc}" -eq 0 ]]; then
  pass "A5 login node-a via hub"
else
  fail "A5 login node-a via hub"
fi

dev_a_rc=1
dev_a_json=""
for _try in 1 2 3 4 5; do
  set +e
  dev_a_json="$(driver files.ts create-device --base-url "${HUB_PUBLIC_URL}" --cookie-file /out/cookies-hub.json \
    --node-id "${NODE_A_ID}" --name node-a-local --session e2e-a 2>&1)"
  dev_a_rc=$?
  set -e
  if [[ "${dev_a_rc}" -eq 0 ]]; then
    break
  fi
  log "create-device node-a failed try=${_try}: ${dev_a_json}"
  docker restart tmex-split-node-a >/dev/null || true
  wait_local_healthy node-a
  login_via_hub "${NODE_A_ID}" node-a || true
  sleep 2
done
printf '%s\n' "${dev_a_json}" | tee "${OUT}/device-a.json"
DEVICE_A_ID="$(jread /out/device-a.json 'j.device.id' || true)"
if [[ "${dev_a_rc}" -eq 0 && -n "${DEVICE_A_ID}" ]]; then
  pass "A6 create local device on node-a"
else
  fail "A6 create local device on node-a (${dev_a_json})"
fi

MARKER_A="TMEX_SPLIT_A_MARKER"
term_a_rc=1
if [[ -n "${DEVICE_A_ID}" ]]; then
  set +e
  driver terminal.ts --base-url "${HUB_PUBLIC_URL}" --cookie-file /out/cookies-hub.json \
    --node-id "${NODE_A_ID}" --device-id "${DEVICE_A_ID}" --marker "${MARKER_A}" --timeout 25000
  term_a_rc=$?
  set -e
fi
if [[ "${term_a_rc}" -eq 0 ]]; then
  pass "A7 terminal marker round-trip on node-a through hub (relay)"
else
  fail "A7 terminal marker round-trip on node-a through hub (relay)"
fi

set +e
login_via_hub "${NODE_B_ID}" node-b
login_b_rc=$?
set -e
if [[ "${login_b_rc}" -eq 0 ]]; then
  pass "A5b login node-b via hub"
else
  fail "A5b login node-b via hub"
fi

set +e
dev_b_json="$(driver files.ts create-device --base-url "${HUB_PUBLIC_URL}" --cookie-file /out/cookies-hub.json \
  --node-id "${NODE_B_ID}" --name node-b-local --session e2e-b)"
dev_b_rc=$?
set -e
printf '%s\n' "${dev_b_json}" | tee "${OUT}/device-b.json"
DEVICE_B_ID="$(jread /out/device-b.json 'j.device.id' || true)"
set +e
root_json="$(driver files.ts create-root --base-url "${HUB_PUBLIC_URL}" --cookie-file /out/cookies-hub.json \
  --node-id "${NODE_B_ID}" --device-id "${DEVICE_B_ID}" --path /e2e)"
root_rc=$?
set -e
printf '%s\n' "${root_json}" | tee "${OUT}/file-root.json"
ROOT_ID="$(jread /out/file-root.json 'j.root?.id ?? ""' || true)"
set +e
list_json="$(driver files.ts list --base-url "${HUB_PUBLIC_URL}" --cookie-file /out/cookies-hub.json \
  --node-id "${NODE_B_ID}" --root-id "${ROOT_ID}" --path /e2e)"
list_rc=$?
content_json="$(driver files.ts content --base-url "${HUB_PUBLIC_URL}" --cookie-file /out/cookies-hub.json \
  --node-id "${NODE_B_ID}" --root-id "${ROOT_ID}" --path /e2e/marker.txt)"
content_rc=$?
set -e
printf '%s\n' "${list_json}" | tee "${OUT}/files-list.json"
printf '%s\n' "${content_json}" | tee "${OUT}/files-content.json"
if [[ "${dev_b_rc}" -eq 0 && "${root_rc}" -eq 0 && "${list_rc}" -eq 0 && "${content_rc}" -eq 0 ]] \
  && echo "${list_json}" | grep -q 'marker.txt' \
  && echo "${content_json}" | grep -q 'hello-e2e'; then
  pass "A8 files list+read on node-b through hub"
else
  fail "A8 files list+read on node-b through hub"
fi

# ---------- B : node-a as entry ----------
ensure_local node-a
set +e
driver login.ts --base-url 'http://node-a:9883' --username "${USER_NAME}" --password "${PASSWORD}" \
  --out /out/cookies-entry.json
login_entry_rc=$?
set -e
if [[ "${login_entry_rc}" -eq 0 ]]; then
  pass 'B1 login node-a entry'
else
  fail 'B1 login node-a entry'
fi

set +e
mesh_entry="$(driver nodes.ts mesh-list --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json)"
mesh_entry_rc=$?
set -e
printf '%s\n' "${mesh_entry}" | tee "${OUT}/mesh-nodes-entry.json"
HUB_NODE_ID="$(docker exec tmex-split-driver bun -e '
  const j = await Bun.file("/out/mesh-nodes-entry.json").json();
  const n = (j.nodes ?? []).find((x) => x.isHub === true);
  if (n) process.stdout.write(n.id);
' || true)"
log "hub node id from node-a mesh: ${HUB_NODE_ID}"
if [[ -n "${HUB_NODE_ID}" ]]; then
  pass "B2 node-a mesh lists hub isHub:true ${HUB_NODE_ID}"
  set +e
  driver login.ts --base-url http://node-a:9883 --username "${USER_NAME}" --password "${PASSWORD}" \
    --target-node-id "${HUB_NODE_ID}" --out /out/cookies-entry.json
  login_hub_via_a_rc=$?
  set -e
  if [[ "${login_hub_via_a_rc}" -eq 0 ]]; then
    pass "B3 login remote hub node via node-a"
  else
    fail "B3 login remote hub node via node-a"
  fi
else
  fail "B2 node-a mesh lists hub isHub:true"
  login_hub_via_a_rc=1
fi

rssh_docker "exec tmex-split-hub bash -lc $(printf '%q' "tmux -L tmex-hub kill-session -t e2e-hub 2>/dev/null || true; tmux -L tmex-hub new-session -d -s e2e-hub 'sh -lc echo READY; exec sh'")"
set +e
dev_h_json="$(driver files.ts create-device --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
  --node-id "${HUB_NODE_ID}" --name hub-local --session e2e-hub)"
dev_h_rc=$?
set -e
printf '%s\n' "${dev_h_json}" | tee "${OUT}/device-hub.json"
DEVICE_H_ID="$(jread /out/device-hub.json 'j.device.id' || true)"
if [[ "${dev_h_rc}" -eq 0 && -n "${DEVICE_H_ID}" ]]; then
  pass "B4 create local device on hub container"
else
  fail "B4 create local device on hub container (${dev_h_json})"
fi

REACH_B="$(docker exec tmex-split-driver bun -e '
  const j = await Bun.file("/out/mesh-nodes-entry.json").json();
  const n = (j.nodes ?? []).find((x) => x.isHub === true);
  process.stdout.write(String(n?.reach ?? "null"));
' || true)"
log "observed hub reach from node-a: ${REACH_B}"
printf '%s\n' "${REACH_B}" > "${OUT}/reach-hub-from-a.txt"

MARKER_B="TMEX_SPLIT_B_MARKER"
set +e
driver terminal.ts --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
  --node-id "${HUB_NODE_ID}" --device-id "${DEVICE_H_ID}" --marker "${MARKER_B}" --timeout 25000
term_b_rc=$?
set -e
if [[ "${term_b_rc}" -eq 0 ]]; then
  pass "B6 terminal marker node-a → remote hub node (reach=${REACH_B})"
else
  fail "B6 terminal marker node-a → remote hub node (reach=${REACH_B})"
fi

# ---------- C : lan + hub down/up ----------
log "connecting lan network"
ensure_local node-a
ensure_local node-b
docker network create tmex-split-local_lan >/dev/null 2>&1 || true
docker network connect tmex-split-local_lan tmex-split-node-a || true
docker network connect tmex-split-local_lan tmex-split-node-b || true
sleep 5
ensure_local node-a
ensure_local node-b

set +e
driver login.ts --base-url http://node-a:9883 --username "${USER_NAME}" --password "${PASSWORD}" \
  --target-node-id "${NODE_B_ID}" --out /out/cookies-entry.json
set -e

set +e
driver nodes.ts wait-reach --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
  --name "${NODE_B_ID}" --reach lan --timeout 90000
reach_lan_rc=$?
set -e
driver nodes.ts mesh-list --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
  > "${OUT}/mesh-nodes-entry-lan.json" || true
if [[ "${reach_lan_rc}" -eq 0 ]]; then
  pass "C1 node-a sees node-b reach=lan within 90s"
else
  fail "C1 node-a sees node-b reach=lan within 90s"
fi

MARKER_C="TMEX_SPLIT_C_LAN"
set +e
driver terminal.ts --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
  --node-id "${NODE_B_ID}" --device-id "${DEVICE_B_ID}" --marker "${MARKER_C}" --timeout 25000
term_c_rc=$?
set -e
if [[ "${term_c_rc}" -eq 0 ]]; then
  pass "C2 terminal marker via LAN"
else
  fail "C2 terminal marker via LAN"
fi

log "stopping remote hub"
rssh_docker "stop tmex-split-hub"
sleep 2

MARKER_CD="TMEX_SPLIT_C_HUBDOWN"
set +e
driver terminal.ts --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
  --node-id "${NODE_B_ID}" --device-id "${DEVICE_B_ID}" --marker "${MARKER_CD}" --timeout 25000
term_cd_rc=$?
list2_json="$(driver files.ts list --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
  --node-id "${NODE_B_ID}" --root-id "${ROOT_ID}" --path /e2e)"
list2_rc=$?
mesh_down="$(driver nodes.ts mesh-list --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json)"
mesh_down_rc=$?
set -e
printf '%s\n' "${mesh_down}" | tee "${OUT}/mesh-nodes-hub-down.json"
if [[ "${term_cd_rc}" -eq 0 ]]; then
  pass "C3 terminal marker with remote hub down"
else
  fail "C3 terminal marker with remote hub down"
fi
if [[ "${list2_rc}" -eq 0 ]] && echo "${list2_json}" | grep -q 'marker.txt'; then
  pass "C4 file list with remote hub down"
else
  fail "C4 file list with remote hub down"
fi
if [[ "${mesh_down_rc}" -eq 0 ]] && echo "${mesh_down}" | grep -q "${NODE_B_ID}"; then
  pass "C5 /api/mesh/nodes still lists node-b"
else
  fail "C5 /api/mesh/nodes still lists node-b"
fi

log "starting remote hub"
rssh_docker "start tmex-split-hub"
wait_remote_hub
ensure_local node-a
ensure_local node-b
sleep 2

set +e
driver nodes.ts wait-hub-online --base-url "${HUB_PUBLIC_URL}" --cookie-file /out/cookies-hub.json \
  --names node-a,node-b --timeout 120000
hub_up_rc=$?
mesh_up="$(driver nodes.ts mesh-list --base-url "${HUB_PUBLIC_URL}" --cookie-file /out/cookies-hub.json)"
mesh_up_rc=$?
set -e
printf '%s\n' "${mesh_up}" | tee "${OUT}/mesh-nodes-hub-up.json"
if [[ "${hub_up_rc}" -eq 0 ]]; then
  pass "C6 both nodes online on hub within 120s"
else
  fail "C6 both nodes online on hub within 120s"
fi
if [[ "${mesh_up_rc}" -eq 0 ]]; then
  pass "C7 existing hub cookies still valid"
else
  fail "C7 existing hub cookies still valid"
fi

# ---------- E before D so D's native install does not pollute restart assertions ----------
log "restart local node-a"
docker restart tmex-split-node-a
wait_local_healthy node-a
sleep 2
set +e
driver login.ts --base-url http://node-a:9883 --username "${USER_NAME}" --password "${PASSWORD}" \
  --out /out/cookies-entry.json
driver login.ts --base-url http://node-a:9883 --username "${USER_NAME}" --password "${PASSWORD}" \
  --target-node-id "${HUB_NODE_ID}" --out /out/cookies-entry.json
re_login_rc=$?
driver nodes.ts wait-hub-online --base-url "${HUB_PUBLIC_URL}" --cookie-file /out/cookies-hub.json \
  --names node-a --timeout 90000
re_up_rc=$?
env_a="$(docker exec tmex-split-node-a bash -lc 'grep -E "TMEX_HUB_URL|TMEX_ROLES" /var/lib/tmex/app.env')"
term_e_json="$(driver terminal.ts --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
  --node-id "${HUB_NODE_ID}" --device-id "${DEVICE_H_ID}" --marker TMEX_SPLIT_E_A --timeout 25000)"
term_e_rc=$?
set -e
printf '%s\n' "${env_a}" | tee "${OUT}/node-a-env-after-restart.txt"
if [[ "${re_up_rc}" -eq 0 ]] && echo "${env_a}" | grep -q "${HUB_PUBLIC_URL}"; then
  pass "E1 docker restart node-a re-uplinks, app.env intact"
else
  fail "E1 docker restart node-a re-uplinks, app.env intact (${env_a})"
fi
if [[ "${term_e_rc}" -eq 0 || "${re_login_rc}" -eq 0 ]]; then
  pass "E2 node-a still reaches hub node after restart"
else
  fail "E2 node-a still reaches hub node after restart"
fi

log "restart remote hub"
rssh_docker "restart tmex-split-hub"
wait_remote_hub
ensure_local node-a
ensure_local node-b
sleep 2
set +e
driver nodes.ts wait-hub-online --base-url "${HUB_PUBLIC_URL}" --cookie-file /out/cookies-hub.json \
  --names node-a,node-b --timeout 120000
hub_re_rc=$?
driver nodes.ts hub-list --base-url "${HUB_PUBLIC_URL}" --cookie-file /out/cookies-hub.json \
  > "${OUT}/hub-nodes-after-restart.json"
docker exec tmex-split-driver bun -e 'const j=await Bun.file("/out/hub-nodes-after-restart.json").json(); const names=(j.nodes||[]).map(n=>n.name); const d=names.filter((n,i)=>names.indexOf(n)!==i); await Bun.write("/out/ghost.txt", d.length?d.join(","):"none");'
ghost="$(cat "${OUT}/ghost.txt" 2>/dev/null || echo unknown)"
set -e
if [[ "${hub_re_rc}" -eq 0 && "${ghost}" == "none" ]]; then
  pass "E3 remote hub restart, nodes reconnect, no ghost rows"
else
  fail "E3 remote hub restart, nodes reconnect, no ghost rows (ghost=${ghost})"
fi

target_exec() {
  local target="$1"
  shift
  case "${target}" in
    hub) rssh_docker "exec tmex-split-hub $*" ;;
    node-b) docker exec tmex-split-node-b "$@" ;;
    *) echo "unknown target ${target}" >&2; return 2 ;;
  esac
}

target_bash() {
  local target="$1"
  local script="$2"
  case "${target}" in
    hub) rssh_docker "exec tmex-split-hub bash -lc $(printf '%q' "${script}")" ;;
    node-b) docker exec tmex-split-node-b bash -lc "${script}" ;;
    *) echo "unknown target ${target}" >&2; return 2 ;;
  esac
}

target_restart() {
  case "$1" in
    hub)
      rssh_docker "restart tmex-split-hub"
      wait_remote_hub
      ;;
    node-b)
      docker restart tmex-split-node-b
      wait_local_healthy node-b
      ;;
    *) echo "unknown target $1" >&2; return 2 ;;
  esac
}

target_ensure_tmux() {
  case "$1" in
    hub)
      rssh_docker "exec tmex-split-hub bash -lc $(printf '%q' "tmux -L tmex-hub has-session -t e2e-hub 2>/dev/null || tmux -L tmex-hub new-session -d -s e2e-hub 'sh -lc echo READY; exec sh'")" || true
      ;;
    node-b)
      docker exec tmex-split-node-b bash -lc \
        'tmux -L tmex-node-b has-session -t e2e-b 2>/dev/null || tmux -L tmex-node-b new-session -d -s e2e-b "sh -lc echo READY; exec sh"' || true
      ;;
    *) echo "unknown target $1" >&2; return 2 ;;
  esac
}

write_mesh_path() {
  local mesh="$1"
  local path_out="$2"
  local tid="$3"
  docker exec -e MESH="${mesh}" -e PATH_OUT="${path_out}" -e TARGET="${tid}" tmex-split-driver bun -e '
    const j = await Bun.file(process.env.MESH).json();
    const n = (j.nodes ?? []).find((x) => x.id === process.env.TARGET);
    const body = {
      reach: n?.reach ?? null,
      transport: n?.transport ?? null,
      direct_capable: n?.direct_capable ?? null,
      row: n ?? null,
    };
    await Bun.write(process.env.PATH_OUT, JSON.stringify(body));
    process.stdout.write(JSON.stringify({
      reach: body.reach,
      transport: body.transport,
      direct_capable: body.direct_capable,
    }));
  ' 2>/dev/null || true
}

# run_direct_scenarios <kind>
# kind=lan → L1..L8 against node-b over docker lan (REQUIRED; host ICE / UDP)
# kind=hub → D1-D3/H1-H3/I1-I2 against hub (WAN; FAIL with evidence if UDP blocked)
run_direct_scenarios() {
  local kind="$1"
  local d1 d2 d3 h1 h2 h3 i1 i2 fallback_transport=relay
  local target target_id device_id
  local mesh_json path_json
  local seq_json seq_err seq_ready seq_input
  local bulk_sha_file bulk_dc_json bulk_relay_json root_json_file
  local enable_log
  local got_dc=0
  local marker

  case "${kind}" in
    hub)
      d1="D1 both rows direct_capable=true"
      d2="D2 transport=dc"
      d3="D3 marker round-trip while transport=dc"
      h1="H1 transport falls back to relay within 30s"
      fallback_transport=relay
      h2="H2 SEQ_1..400 contiguous on entry stream"
      h3="H3 transport returns to dc within 90s"
      i1="I1 8MiB sha256 over dc"
      i2="I2 8MiB sha256 with UDP drop (REST fallback)"
      target=hub
      target_id="${HUB_NODE_ID}"
      device_id="${DEVICE_H_ID}"
      mesh_json=/out/mesh-nodes-direct.json
      path_json=/out/direct-path.json
      seq_json=/out/seq-capture.json
      seq_err=/out/seq-capture.err
      seq_ready=/out/seq-ready.json
      seq_input=/out/seq-producer.txt
      bulk_sha_file="${OUT}/bulk-remote-sha256.txt"
      bulk_dc_json=/out/files-bulk-dc.json
      bulk_relay_json=/out/files-bulk-relay.json
      root_json_file=/out/file-root-hub.json
      enable_log="${OUT}/direct-enable-hub.log"
      marker=TMEX_SPLIT_D
      ;;
    lan)
      d1="L1 both rows direct_capable=true"
      d2="L2 transport=dc"
      d3="L3 marker round-trip while transport=dc"
      h1="L4 transport falls back to ws-secure within 30s"
      fallback_transport=ws-secure
      h2="L5 SEQ_1..400 contiguous on entry stream"
      h3="L6 transport returns to dc within 90s"
      i1="L7 8MiB sha256 over dc"
      i2="L8 8MiB sha256 with UDP drop (REST fallback)"
      target=node-b
      target_id="${NODE_B_ID}"
      device_id="${DEVICE_B_ID}"
      mesh_json=/out/mesh-nodes-direct-lan.json
      path_json=/out/direct-path-lan.json
      seq_json=/out/seq-capture-lan.json
      seq_err=/out/seq-capture-lan.err
      seq_ready=/out/seq-ready-lan.json
      seq_input=/out/seq-producer.txt
      bulk_sha_file="${OUT}/bulk-remote-sha256-lan.txt"
      bulk_dc_json=/out/files-bulk-dc-lan.json
      bulk_relay_json=/out/files-bulk-relay-lan.json
      root_json_file=/out/file-root-lan.json
      enable_log="${OUT}/direct-enable-node-b.log"
      marker=TMEX_SPLIT_D_LAN
      ;;
    *)
      echo "run_direct_scenarios: unknown kind ${kind}" >&2
      return 2
      ;;
  esac

  log "direct scenarios kind=${kind} target=${target} id=${target_id}"

  if [[ -z "${target_id}" || -z "${device_id}" ]]; then
    skip "${d1}" "missing target_id/device_id"
    skip "${d2}" "missing ids"
    skip "${d3}" "missing ids"
    skip "${h1}" "missing ids"
    skip "${h2}" "missing ids"
    skip "${h3}" "missing ids"
    skip "${i1}" "missing ids"
    skip "${i2}" "missing ids"
    return 0
  fi

  set +e
  local direct_a direct_a_rc direct_t direct_t_rc
  direct_a="$(docker exec tmex-split-node-a \
    bun /opt/tmex-pkg/package/bin/tmex.js direct enable --install-dir /opt/tmex 2>&1)"
  direct_a_rc=$?
  direct_t="$(target_exec "${target}" bun /opt/tmex-pkg/package/bin/tmex.js direct enable --install-dir /opt/tmex 2>&1)"
  direct_t_rc=$?
  set -e
  printf '%s\n' "${direct_a}" | tee "${OUT}/direct-enable-node-a.log"
  printf '%s\n' "${direct_t}" | tee "${enable_log}"
  local has_native_a has_native_t
  has_native_a="$(docker exec tmex-split-node-a bash -lc 'test -f /opt/tmex/native/node_datachannel.node && test -f /opt/tmex/native/manifest.json && echo yes || echo no')"
  has_native_t="$(target_bash "${target}" 'test -f /opt/tmex/native/node_datachannel.node && test -f /opt/tmex/native/manifest.json && echo yes || echo no')"
  if [[ "${has_native_a}" != "yes" || "${has_native_t}" != "yes" ]]; then
    skip "${d1}" "native missing a=${has_native_a} t=${has_native_t} a_rc=${direct_a_rc} t_rc=${direct_t_rc}"
    skip "${d2}" "native missing"
    skip "${d3}" "native missing"
    skip "${h1}" "direct skipped (no native)"
    skip "${h2}" "direct skipped (no native)"
    skip "${h3}" "direct skipped (no native)"
    skip "${i1}" "direct skipped (no native)"
    skip "${i2}" "direct skipped (no native)"
    if [[ "${kind}" == "hub" ]]; then
      DIRECT_SKIPPED=1
    fi
    return 0
  fi

  docker restart tmex-split-node-a
  target_restart "${target}"
  wait_local_healthy node-a
  docker exec tmex-split-node-a bash -lc \
    'tmux -L tmex-node-a has-session -t e2e-a 2>/dev/null || tmux -L tmex-node-a new-session -d -s e2e-a "sh -lc echo READY; exec sh"' || true
  target_ensure_tmux "${target}"
  sleep 3
  # docker restart drops tc qdisc; re-apply so L2–L8 actually see netem
  if [[ "${kind}" == "lan" && -n "${TMEX_E2E_LAN_NETEM:-}" ]]; then
    apply_lan_netem || log "WARNING: lan netem re-apply after restart failed"
  fi

  set +e
  driver login.ts --base-url http://node-a:9883 --username "${USER_NAME}" --password "${PASSWORD}" \
    --out /out/cookies-entry.json
  driver nodes.ts wait-direct-capable --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
    --name self --timeout 60000
  local dc_a_rc=$?
  local login_try
  for login_try in $(seq 1 12); do
    if driver login.ts --base-url http://node-a:9883 --username "${USER_NAME}" --password "${PASSWORD}" \
      --target-node-id "${target_id}" --out /out/cookies-entry.json; then
      break
    fi
    log "login to ${target_id} via node-a failed (attempt ${login_try}); retrying"
    sleep 5
  done
  driver nodes.ts wait-direct-capable --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
    --name "${target_id}" --timeout 60000
  local dc_t_rc=$?
  driver nodes.ts mesh-list --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
    > "${OUT}/$(basename "${mesh_json}")"
  local PATH_D
  PATH_D="$(write_mesh_path "${mesh_json}" "${path_json}" "${target_id}")"
  set -e
  if [[ "${dc_a_rc}" -eq 0 && "${dc_t_rc}" -eq 0 ]]; then
    pass "${d1}" "${PATH_D}"
  else
    fail "${d1}" "a=${dc_a_rc} t=${dc_t_rc} ${PATH_D}"
  fi

  set +e
  driver nodes.ts wait-transport --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
    --name "${target_id}" --transport dc --timeout 90000
  local transport_dc_rc=$?
  driver nodes.ts mesh-list --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
    > "${OUT}/$(basename "${mesh_json}")"
  PATH_D="$(write_mesh_path "${mesh_json}" "${path_json}" "${target_id}")"
  set -e
  dump_rtc_logs "${target}"
  local netem_ev=""
  if [[ "${kind}" == "lan" && -n "${TMEX_E2E_LAN_NETEM:-}" ]]; then
    netem_ev="; $(lan_netem_qdisc_evidence || true)"
  fi
  if [[ "${transport_dc_rc}" -eq 0 ]]; then
    got_dc=1
    pass "${d2}" "${PATH_D}${netem_ev}"
  else
    fail "${d2}" "stayed relay/other path=${PATH_D}; $(rtc_evidence "${target}")${netem_ev}"
  fi

  set +e
  driver terminal.ts --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
    --node-id "${target_id}" --device-id "${device_id}" --marker "${marker}" --timeout 25000
  local term_d_rc=$?
  driver nodes.ts mesh-list --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
    > "${OUT}/$(basename "${mesh_json}")"
  PATH_D="$(write_mesh_path "${mesh_json}" "${path_json}" "${target_id}")"
  set -e
  if [[ "${term_d_rc}" -eq 0 && "${got_dc}" -eq 1 ]]; then
    pass "${d3}" "${PATH_D}"
  elif [[ "${term_d_rc}" -eq 0 ]]; then
    fail "${d3}" "marker ok but transport not dc ${PATH_D}"
  else
    fail "${d3}" "marker failed ${PATH_D}"
  fi

  if [[ "${got_dc}" -ne 1 ]]; then
    skip "${h1}" "requires ${d2} transport=dc"
    skip "${h2}" "requires ${d2} transport=dc"
    skip "${h3}" "requires ${d2} transport=dc"
    skip "${i1}" "requires ${d2} transport=dc"
    skip "${i2}" "requires ${d2} transport=dc"
    if [[ "${kind}" == "hub" ]]; then
      DIRECT_DC=0
    fi
    return 0
  fi

  ensure_udp_drop_tool
  target_ensure_tmux "${target}"
  printf '%s\n' 'for i in $(seq 1 400); do echo SEQ_$i; sleep 0.02; done' > "${OUT}/seq-producer.txt"
  rm -f "${OUT}/$(basename "${seq_ready}")"
  set +e
  driver terminal.ts --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
    --node-id "${target_id}" --device-id "${device_id}" \
    --capture-seq --expect-count 400 --seq-prefix SEQ_ \
    --input-file "${seq_input}" --ready-file "${seq_ready}" --timeout 90000 \
    > "${OUT}/$(basename "${seq_json}")" 2> "${OUT}/$(basename "${seq_err}")" &
  local cap_pid=$!
  set -e
  local h1_rc=1
  if wait_file_match "${OUT}/$(basename "${seq_ready}")" '"ok"' 20; then
    sleep 3
    set +e
    drop_direct_udp
    local drop_rc=$?
    driver nodes.ts wait-transport --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
      --name "${target_id}" --transport "${fallback_transport}" --timeout 30000
    h1_rc=$?
    set -e
    dump_rtc_logs "${target}"
    if [[ "${h1_rc}" -eq 0 ]]; then
      pass "${h1}" "mode=${DIRECT_DROP_MODE} drop_rc=${drop_rc}"
    else
      fail "${h1}" "mode=${DIRECT_DROP_MODE} drop_rc=${drop_rc}; $(rtc_evidence "${target}")"
    fi
  else
    kill "${cap_pid}" 2>/dev/null || true
    fail "${h1}" "seq capture did not become ready"
    h1_rc=1
  fi
  set +e
  wait "${cap_pid}"
  local h2_rc=$?
  set -e
  local H2_BODY
  H2_BODY="$(tr '\n' ' ' < "${OUT}/$(basename "${seq_json}")" 2>/dev/null | tr '|' '/' || true)"
  if [[ "${h2_rc}" -eq 0 ]]; then
    pass "${h2}" "${H2_BODY}"
  else
    fail "${h2}" "${H2_BODY}"
  fi
  set +e
  undrop_direct_udp
  driver nodes.ts wait-transport --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
    --name "${target_id}" --transport dc --timeout 90000
  local h3_rc=$?
  driver nodes.ts mesh-list --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
    > "${OUT}/$(basename "${mesh_json}")"
  local PATH_H3
  PATH_H3="$(write_mesh_path "${mesh_json}" "${path_json}" "${target_id}")"
  set -e
  dump_rtc_logs "${target}"
  if [[ "${h3_rc}" -eq 0 ]]; then
    got_dc=1
    pass "${h3}" "${PATH_H3}"
  else
    got_dc=0
    fail "${h3}" "${PATH_H3}; $(rtc_evidence "${target}")"
  fi
  if [[ "${kind}" == "hub" ]]; then
    DIRECT_DC="${got_dc}"
  fi

  if [[ "${got_dc}" -ne 1 ]]; then
    skip "${i1}" "requires transport=dc after H3"
    skip "${i2}" "requires transport=dc after H3"
    return 0
  fi

  set +e
  local bulk_sum bulk_sum_rc
  bulk_sum="$(target_bash "${target}" 'mkdir -p /e2e && dd if=/dev/urandom of=/e2e/bulk.bin bs=1048576 count=8 status=none && sha256sum /e2e/bulk.bin')"
  bulk_sum_rc=$?
  set -e
  printf '%s\n' "${bulk_sum}" | tee "${bulk_sha_file}"
  local EXPECT_SHA
  EXPECT_SHA="$(printf '%s\n' "${bulk_sum}" | awk '/bulk.bin/{print $1; exit}')"
  set +e
  local hub_root_json hub_root_rc
  hub_root_json="$(driver files.ts create-root --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
    --node-id "${target_id}" --device-id "${device_id}" --path /e2e)"
  hub_root_rc=$?
  set -e
  printf '%s\n' "${hub_root_json}" | tee "${OUT}/$(basename "${root_json_file}")"
  local TARGET_ROOT_ID
  TARGET_ROOT_ID="$(jread "${root_json_file}" 'j.root?.id ?? ""' || true)"
  if [[ -z "${TARGET_ROOT_ID}" ]]; then
    set +e
    driver files.ts get --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
      --node-id "${target_id}" --path /api/files/roots > "${OUT}/file-roots-${kind}.json"
    set -e
    TARGET_ROOT_ID="$(jread "/out/file-roots-${kind}.json" '(j.json?.roots??[]).find(r=>r.path==="/e2e")?.id ?? ""' || true)"
  fi
  set +e
  local i1_json i1_rc
  i1_json="$(driver files.ts sha256 --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
    --node-id "${target_id}" --root-id "${TARGET_ROOT_ID}" --path /e2e/bulk.bin)"
  i1_rc=$?
  set -e
  printf '%s\n' "${i1_json}" | tee "${OUT}/$(basename "${bulk_dc_json}")"
  local I1_SHA I1_HDR
  I1_SHA="$(docker exec tmex-split-driver bun -e "const j=await Bun.file('${bulk_dc_json}').json(); process.stdout.write(String(j.sha256??''))" || true)"
  I1_HDR="$(docker exec tmex-split-driver bun -e "const j=await Bun.file('${bulk_dc_json}').json(); process.stdout.write(JSON.stringify({bytes:j.bytes,headers:j.headers,bulkPath:j.bulkPath}))" || true)"
  if [[ "${bulk_sum_rc}" -eq 0 && "${i1_rc}" -eq 0 && -n "${EXPECT_SHA}" && "${I1_SHA}" == "${EXPECT_SHA}" ]]; then
    pass "${i1}" "sha256=${I1_SHA} ${I1_HDR}; bulk DataChannel is browser-only (BulkClient bulk:<id>), REST /api/files/raw rides the mesh link"
  else
    fail "${i1}" "expect=${EXPECT_SHA} got=${I1_SHA} root_rc=${hub_root_rc} ${I1_HDR}"
  fi

  set +e
  drop_direct_udp
  driver nodes.ts wait-transport --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
    --name "${target_id}" --transport "${fallback_transport}" --timeout 30000
  local i2_relay_rc=$?
  local i2_json i2_rc
  i2_json="$(driver files.ts sha256 --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
    --node-id "${target_id}" --root-id "${TARGET_ROOT_ID}" --path /e2e/bulk.bin)"
  i2_rc=$?
  undrop_direct_udp
  set -e
  printf '%s\n' "${i2_json}" | tee "${OUT}/$(basename "${bulk_relay_json}")"
  local I2_SHA I2_HDR
  I2_SHA="$(docker exec tmex-split-driver bun -e "const j=await Bun.file('${bulk_relay_json}').json(); process.stdout.write(String(j.sha256??''))" || true)"
  I2_HDR="$(docker exec tmex-split-driver bun -e "const j=await Bun.file('${bulk_relay_json}').json(); process.stdout.write(JSON.stringify({bytes:j.bytes,headers:j.headers,bulkPath:j.bulkPath}))" || true)"
  if [[ "${i2_rc}" -eq 0 && -n "${EXPECT_SHA}" && "${I2_SHA}" == "${EXPECT_SHA}" ]]; then
    pass "${i2}" "relay_wait=${i2_relay_rc} sha256=${I2_SHA} ${I2_HDR}"
  else
    fail "${i2}" "relay_wait=${i2_relay_rc} expect=${EXPECT_SHA} got=${I2_SHA} ${I2_HDR}"
  fi
}

# LAN DC first: node-a ↔ node-b share docker lan from C onward; host ICE candidates
# are UDP and the existing OUTPUT -p udp DROP on node-a cuts the DC while TCP/WSS uplink lives.
# These L1–L8 rows are REQUIRED (count toward FAILS). Hub D/H/I stay after, and still FAIL
# with evidence when the WAN path cannot establish (VPS UDP filter / symmetric NAT / no TURN-TCP).
log "LAN DataChannel scenarios (node-a ↔ node-b)"
if [[ -n "${TMEX_E2E_LAN_NETEM:-}" ]]; then
  log "lan netem requested: ${TMEX_E2E_LAN_NETEM}"
  apply_lan_netem || log "WARNING: lan netem apply failed before L scenarios"
fi
run_direct_scenarios lan
clear_lan_netem || true

log "WAN DataChannel scenarios (node-a ↔ hub)"
run_direct_scenarios hub

# tmux session 不进 volume：D/E 重启后需补回来，否则 F 终端是空的。
docker exec tmex-split-node-a bash -lc 'tmux -L tmex-node-a has-session -t e2e-a 2>/dev/null || tmux -L tmex-node-a new-session -d -s e2e-a "sh -lc echo READY; exec sh"' || true
docker exec tmex-split-node-b bash -lc 'tmux -L tmex-node-b has-session -t e2e-b 2>/dev/null || tmux -L tmex-node-b new-session -d -s e2e-b "sh -lc echo READY; exec sh"' || true
target_ensure_tmux hub

# ---------- F Playwright from Mac ----------
set +e
BROWSER_ARGS=(
  --base-url "${HUB_PUBLIC_URL}"
  --username "${USER_NAME}"
  --password "${PASSWORD}"
  --out "${OUT}"
  --node-a-name node-a
  --node-b-name node-b
  --node-a-id "${NODE_A_ID}"
  --device-a-id "${DEVICE_A_ID}"
  --marker TMEX_SPLIT_PW_MARKER
  --map-host "${HUB_HOST}"
  --map-ip "${HUB_IP}"
)
if [[ "${TLS_MODE}" == "private-ca" ]]; then
  BROWSER_ARGS+=(--insecure-tls --ca-file "${HUB_E2E}/ca/ca.crt")
fi
bun "${ROOT}/browser.ts" "${BROWSER_ARGS[@]}"
f_rc=$?
set -e
if [[ "${f_rc}" -eq 0 ]]; then
  pass "F Playwright login + sidebar + terminal + passkey"
else
  fail "F Playwright login + sidebar + terminal + passkey (see ${OUT}/f-browser.json)"
fi

# ---------- G revoke node-b ----------
# F 里浏览器做过 logout，hub 侧会话可能已被撤销；吊销前重新登录拿新 cookie
driver login.ts --base-url "${HUB_PUBLIC_URL}" --username "${USER_NAME}" --password "${PASSWORD}" --out /out/cookies-hub.json >/dev/null 2>&1 || true
set +e
split_bun /workspace/scripts/hub-e2e/split/revoke.ts \
  --base-url "${HUB_PUBLIC_URL}" \
  --cookie-file /out/cookies-hub.json \
  --password "${PASSWORD}" \
  --node-id "${NODE_B_ID}" \
  --reason e2e-split-G > "${OUT}/revoke.json"
rev_rc=$?
set -e
if [[ "${rev_rc}" -ne 0 ]]; then
  skip "G revoke-node API failed (see revoke.json); not retrying interactively"
else
  sleep 3
  set +e
  driver nodes.ts hub-list --base-url "${HUB_PUBLIC_URL}" --cookie-file /out/cookies-hub.json \
    > "${OUT}/hub-nodes-after-revoke.json"
  chal="$(driver files.ts get --base-url "${HUB_PUBLIC_URL}" --cookie-file /out/cookies-hub.json \
    --node-id "${NODE_B_ID}" --path /api/auth/mode)"
  chal_rc=$?
  set -e
  printf '%s\n' "${chal}" | tee "${OUT}/node-b-after-revoke.json"
  if echo "${chal}" | grep -qE 'NODE_UNREACHABLE|503|401|revoked'; then
    pass "G node-b unreachable after revoke"
  elif grep -q '"online": false' "${OUT}/hub-nodes-after-revoke.json" && \
       grep -q "${NODE_B_ID}" "${OUT}/hub-nodes-after-revoke.json"; then
    pass "G node-b uplink rejected / offline after revoke"
  else
    fail "G node-b still reachable after revoke (${chal})"
  fi
fi

write_report
log "report at ${OUT}/report.md"
if [[ "${FAILS}" -gt 0 ]]; then
  log "${FAILS} FAIL"
  exit 1
fi
log "all required scenarios passed"
exit 0
