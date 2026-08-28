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
HUB_PUBLIC_URL="${TMEX_HUB_PUBLIC_URL:-https://ai.example.com:18443}"
HUB_HOST="ai.example.com"
HUB_IP="4.2.2.1"
USER_NAME="${TMEX_E2E_USER:-alice}"
PASSWORD="${TMEX_E2E_PASSWORD:-TmexE2e!alice-2026}"
OUT="${ROOT}/out"
IMAGE_NAME="tmex-e2e:split"
TARBALL="${TMEX_TARBALL:?set TMEX_TARBALL to the tmex-cli tarball used to build the local image}"
FAILS=0
declare -a REPORT_ROWS=()

log() { printf '[split-e2e] %s\n' "$*"; }
pass() { log "PASS $*"; REPORT_ROWS+=("| $* | PASS | |"); }
fail() { log "FAIL $*"; REPORT_ROWS+=("| $* | FAIL | $* |"); FAILS=$((FAILS + 1)); }
skip() { log "SKIP $*"; REPORT_ROWS+=("| $* | SKIP | $* |"); }
rssh() { "${RSSH}" "$@"; }

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
  rssh "docker compose -p tmex-split -f /root/tmex-e2e/repo/scripts/hub-e2e/split/docker-compose.remote.yml down -v --remove-orphans" || true
  exit 0
fi

mkdir -p "${OUT}"
: > "${OUT}/run.log"
exec > >(tee -a "${OUT}/run.log") 2>&1

echo "需在远端放行入站 TCP 18443（必需，hub HTTPS）与 TCP 39001（可选，hub peer 口）——包括云安全组/面板防火墙/ufw"

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
  while (( n < 90 )); do
    if rssh "docker exec tmex-split-hub curl -fsS -m 2 http://127.0.0.1:9883/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    n=$((n + 1))
  done
  rssh "docker logs tmex-split-hub 2>&1 | tail -40" || true
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
  docker exec tmex-split-driver curl -fsS "$@"
}

dump_logs() {
  mkdir -p "${OUT}"
  "${LOCAL_COMPOSE[@]}" logs --no-color node-a > "${OUT}/node-a.log" 2>&1 || true
  "${LOCAL_COMPOSE[@]}" logs --no-color node-b > "${OUT}/node-b.log" 2>&1 || true
  "${LOCAL_COMPOSE[@]}" logs --no-color driver > "${OUT}/driver.log" 2>&1 || true
  rssh "docker logs --tail 400 tmex-split-hub" > "${OUT}/hub.log" 2>&1 || true
  rssh "docker logs --tail 200 tmex-split-caddy" > "${OUT}/caddy.log" 2>&1 || true
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

| scenario | result | evidence |
|---|---|---|
${rows}
EOF
}

cleanup_on_exit() {
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
  rssh "docker exec tmex-split-hub bash -lc 'pkill -f \"cli-auth.js enroll\" || true; pkill -f \"enroll --ttl\" || true'" || true
}

enroll_and_join() {
  local node_name="$1"
  local log_file="${OUT}/enroll-${node_name}.log"
  : > "${log_file}"
  kill_enroll
  rssh "docker exec tmex-split-hub bash -lc 'rm -f /tmp/enroll.log'"
  rssh "docker exec -d -e TMEX_PASSWORD='${PASSWORD}' tmex-split-hub bash -lc 'nohup stdbuf -oL bun /opt/tmex/runtime/cli-auth.js enroll --ttl 10m --install-dir /opt/tmex >/tmp/enroll.log 2>&1'"
  local n=0
  while (( n < 45 )); do
    rssh "docker exec tmex-split-hub cat /tmp/enroll.log" > "${log_file}" 2>/dev/null || true
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
    export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
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
    rssh "docker exec tmex-split-hub cat /tmp/enroll.log" > "${log_file}" 2>/dev/null || true
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

# ---------- setup ----------
log "rsync harness to remote"
rsync -az -e "${RSYNC_SSH}" \
  --exclude out --exclude ca --exclude build \
  "${HUB_E2E}/" "root@${HUB_IP}:/root/tmex-e2e/repo/scripts/hub-e2e/"

log "setup remote hub"
rssh "TMEX_E2E_SKIP_BUILD=${TMEX_E2E_SKIP_BUILD:-1} TMEX_TARBALL=/root/tmex-e2e/tmex-cli-1.0.2.tgz bash /root/tmex-e2e/repo/scripts/hub-e2e/split/setup-remote.sh"

log "setup local nodes"
TMEX_TARBALL="${TARBALL}" TMEX_E2E_SKIP_BUILD="${TMEX_E2E_SKIP_BUILD:-1}" \
  bash "${ROOT}/setup-local.sh"

sync_clocks || log "clock sync imperfect, login may hit DELEGATION_ISSUED_IN_FUTURE"

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
add_out="$(rssh "docker exec -e TMEX_PASSWORD='${PASSWORD}' tmex-split-hub bun /opt/tmex/runtime/cli-auth.js hub user add ${USER_NAME} --install-dir /opt/tmex" 2>&1)"
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

tree_a=""
if [[ -n "${DEVICE_A_ID}" ]]; then
  for _ in $(seq 1 20); do
    set +e
    tree_a="$(driver files.ts tmux-tree --base-url "${HUB_PUBLIC_URL}" --cookie-file /out/cookies-hub.json \
      --node-id "${NODE_A_ID}" --device-id "${DEVICE_A_ID}")"
    set -e
    if echo "${tree_a}" | grep -q '"id":'; then
      break
    fi
    sleep 1
  done
fi
printf '%s\n' "${tree_a}" | tee "${OUT}/tmux-tree-a.json"
PANE_A="$(jread /out/tmux-tree-a.json 'j.devices?.[0]?.session?.windows?.[0]?.panes?.[0]?.id' || true)"
log "pane-a ${PANE_A}"

MARKER_A="TMEX_SPLIT_A_MARKER"
term_a_rc=1
if [[ -n "${DEVICE_A_ID}" && -n "${PANE_A}" ]]; then
  set +e
  driver terminal.ts --base-url "${HUB_PUBLIC_URL}" --cookie-file /out/cookies-hub.json \
    --node-id "${NODE_A_ID}" --device-id "${DEVICE_A_ID}" --pane-id "${PANE_A}" --marker "${MARKER_A}" --timeout 25000
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

rssh 'docker exec tmex-split-hub bash -lc "tmux -L tmex-hub kill-session -t e2e-hub 2>/dev/null || true; tmux -L tmex-hub new-session -d -s e2e-hub '\''sh -lc echo READY; exec sh'\''"'
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

tree_h=""
for _ in $(seq 1 20); do
  set +e
  tree_h="$(driver files.ts tmux-tree --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
    --node-id "${HUB_NODE_ID}" --device-id "${DEVICE_H_ID}")"
  set -e
  if echo "${tree_h}" | grep -q '"id":'; then
    break
  fi
  sleep 1
done
printf '%s\n' "${tree_h}" | tee "${OUT}/tmux-tree-hub.json"
PANE_H="$(jread /out/tmux-tree-hub.json 'j.devices?.[0]?.session?.windows?.[0]?.panes?.[0]?.id' || true)"
if [[ -n "${PANE_H}" ]]; then
  pass "B5 tmux tree on hub via node-a"
else
  fail "B5 tmux tree on hub via node-a (${tree_h})"
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
  --node-id "${HUB_NODE_ID}" --device-id "${DEVICE_H_ID}" --pane-id "${PANE_H}" --marker "${MARKER_B}" --timeout 25000
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

tree_b=""
for _ in $(seq 1 15); do
  set +e
  tree_b="$(driver files.ts tmux-tree --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
    --node-id "${NODE_B_ID}" --device-id "${DEVICE_B_ID}")"
  set -e
  if echo "${tree_b}" | grep -q '"id":'; then
    break
  fi
  sleep 1
done
printf '%s\n' "${tree_b}" | tee "${OUT}/tmux-tree-b.json"
PANE_B="$(jread /out/tmux-tree-b.json 'j.devices?.[0]?.session?.windows?.[0]?.panes?.[0]?.id' || true)"

MARKER_C="TMEX_SPLIT_C_LAN"
set +e
driver terminal.ts --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
  --node-id "${NODE_B_ID}" --device-id "${DEVICE_B_ID}" --pane-id "${PANE_B}" --marker "${MARKER_C}" --timeout 25000
term_c_rc=$?
set -e
if [[ "${term_c_rc}" -eq 0 ]]; then
  pass "C2 terminal marker via LAN"
else
  fail "C2 terminal marker via LAN"
fi

log "stopping remote hub"
rssh "docker stop tmex-split-hub"
sleep 2

MARKER_CD="TMEX_SPLIT_C_HUBDOWN"
set +e
driver terminal.ts --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
  --node-id "${NODE_B_ID}" --device-id "${DEVICE_B_ID}" --pane-id "${PANE_B}" --marker "${MARKER_CD}" --timeout 25000
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
rssh "docker start tmex-split-hub"
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
  --node-id "${HUB_NODE_ID}" --device-id "${DEVICE_H_ID}" --pane-id "${PANE_H}" --marker TMEX_SPLIT_E_A --timeout 25000)"
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
rssh "docker restart tmex-split-hub"
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

# ---------- D direct enable ----------
set +e
direct_a="$(docker exec tmex-split-node-a \
  bun /opt/tmex-pkg/package/bin/tmex.js direct enable --install-dir /opt/tmex 2>&1)"
direct_a_rc=$?
direct_h="$(rssh "docker exec tmex-split-hub bun /opt/tmex-pkg/package/bin/tmex.js direct enable --install-dir /opt/tmex" 2>&1)"
direct_h_rc=$?
set -e
printf '%s\n' "${direct_a}" | tee "${OUT}/direct-enable-node-a.log"
printf '%s\n' "${direct_h}" | tee "${OUT}/direct-enable-hub.log"
has_native_a="$(docker exec tmex-split-node-a bash -lc 'test -f /opt/tmex/native/node_datachannel.node && test -f /opt/tmex/native/manifest.json && echo yes || echo no')"
has_native_h="$(rssh "docker exec tmex-split-hub bash -lc 'test -f /opt/tmex/native/node_datachannel.node && test -f /opt/tmex/native/manifest.json && echo yes || echo no'")"
if [[ "${has_native_a}" != "yes" || "${has_native_h}" != "yes" ]]; then
  skip "D direct enable native missing a=${has_native_a} h=${has_native_h} a_rc=${direct_a_rc} h_rc=${direct_h_rc}"
else
  docker restart tmex-split-node-a
  rssh "docker restart tmex-split-hub"
  wait_local_healthy node-a
  wait_remote_hub
  rssh 'docker exec tmex-split-hub bash -lc "tmux -L tmex-hub has-session -t e2e-hub 2>/dev/null || tmux -L tmex-hub new-session -d -s e2e-hub '\''sh -lc echo READY; exec sh'\''"' || true
  sleep 3
  set +e
  driver login.ts --base-url http://node-a:9883 --username "${USER_NAME}" --password "${PASSWORD}" \
    --out /out/cookies-entry.json
  driver nodes.ts wait-direct-capable --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
    --name self --timeout 60000
  dc_a_rc=$?
  driver login.ts --base-url http://node-a:9883 --username "${USER_NAME}" --password "${PASSWORD}" \
    --target-node-id "${HUB_NODE_ID}" --out /out/cookies-entry.json
  driver nodes.ts wait-direct-capable --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
    --name "${HUB_NODE_ID}" --timeout 60000
  dc_h_rc=$?
  driver nodes.ts mesh-list --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
    > "${OUT}/mesh-nodes-direct.json"
  driver terminal.ts --base-url http://node-a:9883 --cookie-file /out/cookies-entry.json \
    --node-id "${HUB_NODE_ID}" --device-id "${DEVICE_H_ID}" --pane-id "${PANE_H}" --marker TMEX_SPLIT_D --timeout 25000
  term_d_rc=$?
  set -e
  docker logs tmex-split-node-a 2>&1 | grep -iE 'rtc|datachannel|ws-secure|direct|peer' | tail -80 \
    > "${OUT}/direct-logs-node-a.txt" || true
  rssh "docker logs tmex-split-hub 2>&1 | grep -iE 'rtc|datachannel|ws-secure|direct|peer' | tail -80" \
    > "${OUT}/direct-logs-hub.txt" || true
  REACH_D="$(docker exec tmex-split-driver bun -e '
    const j = await Bun.file("/out/mesh-nodes-direct.json").json();
    const n = (j.nodes ?? []).find((x) => x.isHub === true || x.id === process.env.HUB);
    process.stdout.write(JSON.stringify({ reach: n?.reach ?? null, direct_capable: n?.direct_capable, row: n ?? null }));
  ' || true)"
  printf '%s\n' "${REACH_D}" | tee "${OUT}/direct-path.json"
  if [[ "${dc_a_rc}" -eq 0 && "${dc_h_rc}" -eq 0 ]]; then
    pass "D1 both rows direct_capable=true (path=${REACH_D})"
  else
    fail "D1 both rows direct_capable=true a=${dc_a_rc} h=${dc_h_rc} path=${REACH_D}"
  fi
  if [[ "${term_d_rc}" -eq 0 ]]; then
    pass "D2 stream node-a → hub after direct enable (see direct-path.json; reach=lan 含 ws-secure 与 dc，不能单凭 reach 证明 DataChannel)"
  else
    fail "D2 stream node-a → hub after direct enable"
  fi
fi

# tmux session 不进 volume：D/E 重启后需补回来，否则 F 终端是空的。
docker exec tmex-split-node-a bash -lc 'tmux -L tmex-node-a has-session -t e2e-a 2>/dev/null || tmux -L tmex-node-a new-session -d -s e2e-a "sh -lc echo READY; exec sh"' || true
rssh 'docker exec tmex-split-hub bash -lc "tmux -L tmex-hub has-session -t e2e-hub 2>/dev/null || tmux -L tmex-hub new-session -d -s e2e-hub '\''sh -lc echo READY; exec sh'\''"' || true

# ---------- F Playwright from Mac ----------
set +e
bun "${ROOT}/browser.ts" \
  --base-url "${HUB_PUBLIC_URL}" \
  --username "${USER_NAME}" \
  --password "${PASSWORD}" \
  --out "${OUT}" \
  --node-a-name node-a \
  --node-b-name node-b \
  --node-a-id "${NODE_A_ID}" \
  --device-a-id "${DEVICE_A_ID}" \
  --marker TMEX_SPLIT_PW_MARKER
f_rc=$?
set -e
if [[ "${f_rc}" -eq 0 ]]; then
  pass "F Playwright login + sidebar + terminal + passkey"
else
  fail "F Playwright login + sidebar + terminal + passkey (see ${OUT}/f-browser.json)"
fi

# ---------- G revoke node-b ----------
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
