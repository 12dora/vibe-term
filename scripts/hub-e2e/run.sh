#!/usr/bin/env bash
# tmex hub/node Docker e2e 驱动。用法：
#   TMEX_TARBALL=/path/to/tmex-cli-1.0.2.tgz scripts/hub-e2e/run.sh
#   scripts/hub-e2e/run.sh --image-tar tmex-e2e.tar
#   scripts/hub-e2e/run.sh down
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${ROOT}/../.." && pwd)"
export TMEX_REPO_ROOT="${TMEX_REPO_ROOT:-${REPO_ROOT}}"
COMPOSE=(docker compose -p tmex-e2e -f "${ROOT}/docker-compose.yml")
IMAGE_NAME="tmex-e2e:latest"
PLATFORM="linux/amd64"
USER_NAME="${TMEX_E2E_USER:-alice}"
PASSWORD="${TMEX_E2E_PASSWORD:-TmexE2e!alice-2026}"
OUT="${ROOT}/out"
FAILS=0
declare -a REPORT_ROWS=()

log() { printf '[hub-e2e] %s\n' "$*"; }
pass() {
  log "PASS $*"
  REPORT_ROWS+=("| $* | PASS | |")
}
fail() {
  log "FAIL $*"
  REPORT_ROWS+=("| $* | FAIL | $* |")
  FAILS=$((FAILS + 1))
}
skip() {
  log "SKIP $*"
  REPORT_ROWS+=("| $* | SKIP | $* |")
}

usage() {
  cat <<'EOF'
Usage:
  TMEX_TARBALL=<tmex-cli.tgz> scripts/hub-e2e/run.sh
  scripts/hub-e2e/run.sh --image-tar <tmex-e2e.tar>
  scripts/hub-e2e/run.sh down
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" == "down" ]]; then
  "${COMPOSE[@]}" down -v --remove-orphans || true
  exit 0
fi

IMAGE_TAR=""
if [[ "${1:-}" == "--image-tar" ]]; then
  IMAGE_TAR="${2:-}"
  if [[ -z "${IMAGE_TAR}" ]]; then
    echo "missing --image-tar path" >&2
    exit 2
  fi
fi

mkdir -p "${OUT}" "${ROOT}/build" "${ROOT}/ca"
: > "${OUT}/run.log"
exec > >(tee -a "${OUT}/run.log") 2>&1

dump_logs() {
  mkdir -p "${OUT}"
  "${COMPOSE[@]}" logs --no-color hub > "${OUT}/hub.log" 2>&1 || true
  "${COMPOSE[@]}" logs --no-color node-a > "${OUT}/node-a.log" 2>&1 || true
  "${COMPOSE[@]}" logs --no-color node-b > "${OUT}/node-b.log" 2>&1 || true
  "${COMPOSE[@]}" logs --no-color caddy > "${OUT}/caddy.log" 2>&1 || true
}

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
  docker logs "$("${COMPOSE[@]}" ps -q "${svc}")" 2>&1 | tail -40 || true
  return 1
}

cli() {
  local svc="$1"
  shift
  # 认证命令必须直接跑 Bun runtime/cli-auth.js。
  # node dist/cli-node.js 会再 spawn bun，但在本容器里子进程 stdout 被吞掉，
  # enroll 的 join token 因此写不进日志。
  local -a env_flags=(-e "TMEX_PASSWORD=${PASSWORD}" -e NODE_EXTRA_CA_CERTS=/ca/ca.crt)
  if [[ -n "${TMEX_PASSWORD_OLD:-}" ]]; then
    env_flags+=(-e "TMEX_PASSWORD_OLD=${TMEX_PASSWORD_OLD}")
  fi
  docker exec "${env_flags[@]}" \
    "tmex-e2e-${svc}" \
    bun /opt/tmex/runtime/cli-auth.js "$@" --install-dir /opt/tmex
}

# driver-dist/<name>.js 存在时优先使用（本机 `bun build --target bun` 预打包，远程无需 node_modules）。
driver() {
  local name="$1"
  local bundled="${ROOT}/driver-dist/${name%.ts}.js"
  local -a env_flags=(-e NODE_EXTRA_CA_CERTS=/ca/ca.crt)
  if [[ -n "${TMEX_TOTP:-}" ]]; then
    env_flags+=(-e "TMEX_TOTP=${TMEX_TOTP}")
  fi
  if [[ -f "${bundled}" ]]; then
    docker exec -w /workspace "${env_flags[@]}" \
      tmex-e2e-driver bun "/workspace/scripts/hub-e2e/driver-dist/${name%.ts}.js" "${@:2}"
  else
    docker exec -w /workspace "${env_flags[@]}" \
      tmex-e2e-driver bun /workspace/scripts/hub-e2e/driver/"${name}" "${@:2}"
  fi
}

curl_hub() {
  docker exec tmex-e2e-driver \
    curl -fsS --cacert /ca/ca.crt "$@"
}

kill_enroll() {
  docker exec tmex-e2e-hub bash -lc "pkill -f 'cli-auth.js' || true; pkill -f 'enroll --ttl' || true" || true
}

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

enroll_and_join() {
  local node_name="$1"
  local log_file="${OUT}/enroll-${node_name}.log"
  : > "${log_file}"
  kill_enroll
  docker exec -e TMEX_PASSWORD="${PASSWORD}" -e NODE_EXTRA_CA_CERTS=/ca/ca.crt tmex-e2e-hub \
    stdbuf -oL -eL bun /opt/tmex/runtime/cli-auth.js enroll --ttl 10m --install-dir /opt/tmex \
    > "${log_file}" 2>&1 &
  local enroll_pid=$!
  if ! wait_file_match "${log_file}" 'join token: [A-Za-z0-9_-]+' 45; then
    kill "${enroll_pid}" 2>/dev/null || true
    kill_enroll
    echo "enroll did not print token; log:" >&2
    cat "${log_file}" >&2 || true
    return 1
  fi
  local token
  token="$(grep -E 'join token: ' "${log_file}" | tail -n1 | awk '{print $3}')"
  if [[ ${#token} -lt 80 ]]; then
    kill "${enroll_pid}" 2>/dev/null || true
    kill_enroll
    echo "token too short: ${token}" >&2
    return 1
  fi
  log "got enroll token for ${node_name} (len=${#token})"

  "${COMPOSE[@]}" stop "${node_name}"
  set +e
  "${COMPOSE[@]}" run --rm --no-deps --entrypoint bash "${node_name}" -lc "
    set +e
    export NODE_EXTRA_CA_CERTS=/ca/ca.crt
    # writeEnvFile 用 rename 写 /opt/tmex/app.env：若该路径是 symlink，rename 会换成 overlay 普通文件，
    # --rm 后丢失。所以先做成 volume 上文件的拷贝，join 后再拷回 volume。
    rm -f /opt/tmex/app.env
    cp /var/lib/tmex/app.env /opt/tmex/app.env
    mkdir -p /opt/tmex/native /var/lib/tmex/native
    bun /opt/tmex/runtime/cli-auth.js hub join https://hub.tmex.test --token '${token}' --name '${node_name}' --install-dir /opt/tmex
    join_code=\$?
    echo JOIN_EXIT=\$join_code
    cp /opt/tmex/app.env /var/lib/tmex/app.env
    grep -E '^TMEX_HUB_URL=' /var/lib/tmex/app.env || true
    grep -E '^TMEX_ROLES=' /var/lib/tmex/app.env || true
    grep -q 'TMEX_HUB_URL=https://hub.tmex.test' /var/lib/tmex/app.env || exit 20
    grep -q 'TMEX_ROLES=node' /var/lib/tmex/app.env || exit 21
    exit 0
  " | tee "${OUT}/join-${node_name}.log"
  local join_ok=${PIPESTATUS[0]}
  set -e
  if [[ "${join_ok}" -ne 0 ]]; then
    kill "${enroll_pid}" 2>/dev/null || true
    kill_enroll
    echo "hub join did not persist TMEX_HUB_URL/TMEX_ROLES for ${node_name}" >&2
    return 1
  fi

  if ! wait_file_match "${log_file}" 'node admitted' 60; then
    log "warning: enroll log did not show 'node admitted' for ${node_name}; continuing after join state write"
  fi
  kill "${enroll_pid}" 2>/dev/null || true
  kill_enroll
  "${COMPOSE[@]}" start "${node_name}"
  wait_healthy "${node_name}"
}

write_report() {
  local rows=""
  if ((${#REPORT_ROWS[@]} > 0)); then
    rows="$(printf '%s\n' "${REPORT_ROWS[@]}")"
  fi
  cat > "${OUT}/report.md" <<EOF
# tmex hub-e2e report

- date: $(date -u +%Y-%m-%dT%H:%M:%SZ)
- image: ${IMAGE_NAME}
- tarball: ${TMEX_TARBALL:-n/a}

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

# --- build / load ---
if [[ -n "${IMAGE_TAR}" ]]; then
  log "loading image tar ${IMAGE_TAR}"
  docker load -i "${IMAGE_TAR}"
elif [[ "${TMEX_E2E_SKIP_BUILD:-}" == "1" ]] && docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
  log "skipping build (TMEX_E2E_SKIP_BUILD=1, ${IMAGE_NAME} exists)"
else
  if [[ -z "${TMEX_TARBALL:-}" ]]; then
    echo "TMEX_TARBALL is required unless --image-tar is given" >&2
    exit 2
  fi
  if [[ ! -f "${TMEX_TARBALL}" ]]; then
    echo "tarball not found: ${TMEX_TARBALL}" >&2
    exit 2
  fi
  cp "${TMEX_TARBALL}" "${ROOT}/build/tmex-cli.tgz"
  log "building ${IMAGE_NAME} (--platform ${PLATFORM})"
  docker build --platform "${PLATFORM}" -t "${IMAGE_NAME}" -f "${ROOT}/Dockerfile" "${ROOT}"
fi

log "generating CA"
bash "${ROOT}/gen-ca.sh"

log "compose down (clean volumes)"
"${COMPOSE[@]}" down -v --remove-orphans || true

log "compose up (serialized; qemu/amd64 下并行启动会卡住 bun)"
"${COMPOSE[@]}" up -d hub
wait_healthy hub
"${COMPOSE[@]}" up -d node-a
wait_healthy node-a
"${COMPOSE[@]}" up -d node-b
wait_healthy node-b
"${COMPOSE[@]}" up -d caddy driver
sleep 2

# ---------- scenario 1 ----------
set +e
health_json="$(curl_hub https://hub.tmex.test/healthz)"
health_rc=$?
set -e
if [[ "${health_rc}" -eq 0 ]] && echo "${health_json}" | grep -q '"status":"ok"'; then
  pass "1a hub /healthz ok"
else
  fail "1a hub /healthz ok (rc=${health_rc} body=${health_json})"
fi

set +e
add_out="$(cli hub hub user add "${USER_NAME}" 2>&1)"
add_rc=$?
set -e
printf '%s\n' "${add_out}" | tee "${OUT}/hub-user-add.log"
if [[ "${add_rc}" -eq 0 ]] && echo "${add_out}" | grep -q "user ${USER_NAME} created"; then
  pass "1b hub user add ${USER_NAME}"
else
  fail "1b hub user add ${USER_NAME} (rc=${add_rc})"
fi

set +e
mode_json="$(curl_hub https://hub.tmex.test/api/auth/mode)"
mode_rc=$?
set -e
printf '%s\n' "${mode_json}" | tee "${OUT}/auth-mode.json"
if [[ "${mode_rc}" -eq 0 ]] \
  && echo "${mode_json}" | grep -q '"rootEpoch"' \
  && echo "${mode_json}" | grep -q '"rootPublicKey"' \
  && echo "${mode_json}" | grep -q '"hubPublicUrl"' \
  && echo "${mode_json}" | grep -q 'hub.tmex.test'; then
  pass "1c /api/auth/mode mesh fields"
else
  fail "1c /api/auth/mode mesh fields (body=${mode_json})"
fi

# ---------- enroll + join ----------
if enroll_and_join node-a && enroll_and_join node-b; then
  pass "2a enroll+join node-a and node-b"
else
  fail "2a enroll+join node-a and node-b"
fi

# login at hub (needed for /api/hub/nodes)
set +e
driver login.ts --base-url https://hub.tmex.test --username "${USER_NAME}" --password "${PASSWORD}" --out /out/cookies-hub.json
login_hub_rc=$?
set -e
if [[ "${login_hub_rc}" -eq 0 ]]; then
  pass "2b login hub entry"
else
  fail "2b login hub entry"
fi

set +e
driver nodes.ts wait-hub-online --base-url https://hub.tmex.test --cookie-file /out/cookies-hub.json --names node-a,node-b --timeout 120000
hub_online_rc=$?
set -e
driver nodes.ts hub-list --base-url https://hub.tmex.test --cookie-file /out/cookies-hub.json > "${OUT}/hub-nodes.json" || true
if [[ "${hub_online_rc}" -eq 0 ]]; then
  pass "2c /api/hub/nodes both online"
else
  fail "2c /api/hub/nodes both online"
fi

# ---------- scenario 3 ----------
set +e
mesh_json="$(driver nodes.ts mesh-list --base-url https://hub.tmex.test --cookie-file /out/cookies-hub.json)"
mesh_rc=$?
set -e
printf '%s\n' "${mesh_json}" | tee "${OUT}/mesh-nodes-hub.json"
if [[ "${mesh_rc}" -eq 0 ]] && echo "${mesh_json}" | grep -q '"online": true'; then
  pass "3a /api/mesh/nodes lists peers"
else
  fail "3a /api/mesh/nodes lists peers"
fi

NODE_B_ID="$(docker exec tmex-e2e-driver bun -e '
  const j = await Bun.file("/out/hub-nodes.json").json();
  const n = (j.nodes ?? []).find((x) => x.name === "node-b");
  if (!n) throw new Error("node-b missing from hub-nodes");
  process.stdout.write(n.id);
')"

if [[ -z "${NODE_B_ID}" ]]; then
  fail "3b resolve node-b id"
else
  pass "3b resolve node-b id ${NODE_B_ID}"
  set +e
  driver login.ts --base-url https://hub.tmex.test --username "${USER_NAME}" --password "${PASSWORD}" \
    --target-node-id "${NODE_B_ID}" --out /out/cookies-hub.json
  login_b_rc=$?
  set -e
  if [[ "${login_b_rc}" -eq 0 ]]; then
    pass "3c login node-b via hub entry"
  else
    fail "3c login node-b via hub entry"
  fi
fi

docker exec tmex-e2e-node-b bash -lc '
  tmux -L tmex-node-b kill-session -t e2e-b 2>/dev/null || true
  mkdir -p /e2e
  echo "hello-e2e" > /e2e/marker.txt
  tmux -L tmex-node-b new-session -d -s e2e-b "sh -lc '"'"'echo READY; exec sh'"'"'"
'
PANE_B="$(docker exec tmex-e2e-node-b tmux -L tmex-node-b display-message -p -t e2e-b '#{pane_id}')"

set +e
dev_json="$(driver files.ts create-device --base-url https://hub.tmex.test --cookie-file /out/cookies-hub.json \
  --node-id "${NODE_B_ID}" --name node-b-local --session e2e-b)"
dev_rc=$?
set -e
printf '%s\n' "${dev_json}" | tee "${OUT}/device-b.json"
DEVICE_B_ID="$(docker exec tmex-e2e-driver bun -e 'const j=await Bun.file("/out/device-b.json").json(); process.stdout.write(j.device.id)')"
if [[ "${dev_rc}" -eq 0 && -n "${DEVICE_B_ID}" ]]; then
  pass "3d create local device on node-b"
else
  fail "3d create local device on node-b (${dev_json})"
fi

# pane 兜底：terminal.ts 优先用 STATE_SNAPSHOT 里的活动 pane，这里只提供种子值
log "seed pane ${PANE_B}"

set +e
driver nodes.ts wait-reach --base-url https://hub.tmex.test --cookie-file /out/cookies-hub.json \
  --name "${NODE_B_ID}" --reach relay --timeout 30000
reach_relay_rc=$?
set -e
if [[ "${reach_relay_rc}" -eq 0 ]]; then
  pass "3f node-b reach=relay from hub entry"
else
  fail "3f node-b reach=relay from hub entry"
  driver nodes.ts mesh-list --base-url https://hub.tmex.test --cookie-file /out/cookies-hub.json \
    > "${OUT}/mesh-nodes-hub-reach.json" || true
fi

MARKER1="TMEX_E2E_MARKER_001"
set +e
driver terminal.ts --base-url https://hub.tmex.test --cookie-file /out/cookies-hub.json \
  --node-id "${NODE_B_ID}" --device-id "${DEVICE_B_ID}" --pane-id "${PANE_B}" --marker "${MARKER1}" --timeout 25000
term1_rc=$?
set -e
if [[ "${term1_rc}" -eq 0 ]]; then
  pass "3g terminal marker round-trip via hub (relay)"
else
  fail "3g terminal marker round-trip via hub (relay)"
fi

# 在动 docker network 之前先把 node-a 入口 cookie 建好（connect 会抖 uplink）
set +e
driver login.ts --base-url https://entry.tmex.test --username "${USER_NAME}" --password "${PASSWORD}" \
  --out /out/cookies-entry.json
login_entry_rc=$?
set -e
if [[ "${login_entry_rc}" -eq 0 ]]; then
  pass "4a login node-a entry"
else
  fail "4a login node-a entry"
fi

set +e
driver nodes.ts wait-present --base-url https://entry.tmex.test --cookie-file /out/cookies-entry.json \
  --name "${NODE_B_ID}" --timeout 60000
present_rc=$?
set -e
if [[ "${present_rc}" -ne 0 ]]; then
  fail "4b node-b never appeared in node-a /api/mesh/nodes (hubNodeId=$(driver files.ts get --base-url https://entry.tmex.test --cookie-file /out/cookies-entry.json --path /api/auth/mode 2>/dev/null | head -c 200))"
else
  set +e
  driver login.ts --base-url https://entry.tmex.test --username "${USER_NAME}" --password "${PASSWORD}" \
    --target-node-id "${NODE_B_ID}" --out /out/cookies-entry.json
  login_entry_b_rc=$?
  set -e
  if [[ "${login_entry_b_rc}" -eq 0 ]]; then
    pass "4b login node-b via node-a entry (pre-lan)"
  else
    fail "4b login node-b via node-a entry (pre-lan)"
  fi
fi

# ---------- scenario 4: connect lan, entry = node-a ----------
log "connecting lan network"
docker network create tmex-e2e_lan >/dev/null 2>&1 || true
docker network connect tmex-e2e_lan tmex-e2e-node-a || true
docker network connect tmex-e2e_lan tmex-e2e-node-b || true
sleep 5
set +e
driver nodes.ts wait-hub-online --base-url https://hub.tmex.test --cookie-file /out/cookies-hub.json \
  --names node-a,node-b --timeout 90000
set -e

set +e
driver nodes.ts wait-reach --base-url https://entry.tmex.test --cookie-file /out/cookies-entry.json \
  --name "${NODE_B_ID}" --reach lan --timeout 60000
reach_lan_rc=$?
set -e
if [[ "${reach_lan_rc}" -eq 0 ]]; then
  pass "4c node-b reach=lan from node-a within 60s"
else
  fail "4c node-b reach=lan from node-a within 60s"
  driver nodes.ts mesh-list --base-url https://entry.tmex.test --cookie-file /out/cookies-entry.json \
    > "${OUT}/mesh-nodes-entry-lan.json" || true
fi

MARKER2="TMEX_E2E_MARKER_002"
set +e
driver terminal.ts --base-url https://entry.tmex.test --cookie-file /out/cookies-entry.json \
  --node-id "${NODE_B_ID}" --device-id "${DEVICE_B_ID}" --pane-id "${PANE_B}" --marker "${MARKER2}"
term2_rc=$?
set -e
if [[ "${term2_rc}" -eq 0 ]]; then
  pass "4d terminal marker round-trip via lan"
else
  fail "4d terminal marker round-trip via lan"
fi

# ---------- scenario 5 files ----------
set +e
root_json="$(driver files.ts create-root --base-url https://hub.tmex.test --cookie-file /out/cookies-hub.json \
  --node-id "${NODE_B_ID}" --device-id "${DEVICE_B_ID}" --path /e2e)"
root_rc=$?
set -e
printf '%s\n' "${root_json}" | tee "${OUT}/file-root.json"
ROOT_ID="$(docker exec tmex-e2e-driver bun -e 'const j=await Bun.file("/out/file-root.json").json(); process.stdout.write(j.root?.id ?? "")')"
set +e
list_json="$(driver files.ts list --base-url https://hub.tmex.test --cookie-file /out/cookies-hub.json \
  --node-id "${NODE_B_ID}" --root-id "${ROOT_ID}" --path /e2e)"
list_rc=$?
content_json="$(driver files.ts content --base-url https://hub.tmex.test --cookie-file /out/cookies-hub.json \
  --node-id "${NODE_B_ID}" --root-id "${ROOT_ID}" --path /e2e/marker.txt)"
content_rc=$?
set -e
printf '%s\n' "${list_json}" | tee "${OUT}/files-list.json"
printf '%s\n' "${content_json}" | tee "${OUT}/files-content.json"
if [[ "${root_rc}" -eq 0 && "${list_rc}" -eq 0 && "${content_rc}" -eq 0 ]] \
  && echo "${list_json}" | grep -q 'marker.txt' \
  && echo "${content_json}" | grep -q 'hello-e2e'; then
  pass "5 files list+read /e2e/marker.txt via entry"
else
  fail "5 files list+read /e2e/marker.txt via entry"
fi

# ---------- scenario 6 hub down ----------
log "stopping hub"
docker stop tmex-e2e-hub

MARKER3="TMEX_E2E_MARKER_003"
set +e
driver terminal.ts --base-url https://entry.tmex.test --cookie-file /out/cookies-entry.json \
  --node-id "${NODE_B_ID}" --device-id "${DEVICE_B_ID}" --pane-id "${PANE_B}" --marker "${MARKER3}"
term3_rc=$?
list2_json="$(driver files.ts list --base-url https://entry.tmex.test --cookie-file /out/cookies-entry.json \
  --node-id "${NODE_B_ID}" --root-id "${ROOT_ID}" --path /e2e)"
list2_rc=$?
mesh_down="$(driver nodes.ts mesh-list --base-url https://entry.tmex.test --cookie-file /out/cookies-entry.json)"
mesh_down_rc=$?
set -e
printf '%s\n' "${mesh_down}" | tee "${OUT}/mesh-nodes-hub-down.json"
if [[ "${term3_rc}" -eq 0 ]]; then
  pass "6a terminal marker with hub down"
else
  fail "6a terminal marker with hub down"
fi
if [[ "${list2_rc}" -eq 0 ]] && echo "${list2_json}" | grep -q 'marker.txt'; then
  pass "6b file list with hub down"
else
  fail "6b file list with hub down"
fi
if [[ "${mesh_down_rc}" -eq 0 ]] && echo "${mesh_down}" | grep -q "${NODE_B_ID}"; then
  pass "6c /api/mesh/nodes still lists node-b"
else
  fail "6c /api/mesh/nodes still lists node-b"
fi

# ---------- scenario 7 hub up ----------
log "starting hub"
docker start tmex-e2e-hub
wait_healthy hub
sleep 2

set +e
driver nodes.ts wait-hub-online --base-url https://hub.tmex.test --cookie-file /out/cookies-hub.json \
  --names node-a,node-b --timeout 90000
hub_up_rc=$?
mode2="$(curl_hub https://hub.tmex.test/api/auth/mode)"
mesh_up="$(driver nodes.ts mesh-list --base-url https://hub.tmex.test --cookie-file /out/cookies-hub.json)"
mesh_up_rc=$?
set -e
printf '%s\n' "${mesh_up}" | tee "${OUT}/mesh-nodes-hub-up.json"
if [[ "${hub_up_rc}" -eq 0 ]]; then
  pass "7a both nodes online on hub within 90s"
else
  fail "7a both nodes online on hub within 90s"
fi
if [[ "${mesh_up_rc}" -eq 0 ]]; then
  pass "7b existing hub cookies still work"
else
  fail "7b existing hub cookies still work (mode=${mode2})"
fi

# ---------- scenario 8 direct enable (may SKIP) ----------
set +e
direct_out="$(docker exec -e NODE_EXTRA_CA_CERTS=/ca/ca.crt tmex-e2e-node-a \
  bun /opt/tmex-pkg/package/bin/tmex.js direct enable --install-dir /opt/tmex 2>&1)"
direct_rc=$?
set -e
printf '%s\n' "${direct_out}" | tee "${OUT}/direct-enable.log"
has_native="$(docker exec tmex-e2e-node-a bash -lc 'test -f /opt/tmex/native/node_datachannel.node && test -f /opt/tmex/native/manifest.json && echo yes || echo no')"
if [[ "${has_native}" != "yes" ]]; then
  skip "8 direct enable native missing (rc=${direct_rc}): ${direct_out}"
else
  docker restart tmex-e2e-node-a
  wait_healthy node-a
  set +e
  driver login.ts --base-url https://entry.tmex.test --username "${USER_NAME}" --password "${PASSWORD}" \
    --out /out/cookies-entry.json
  driver nodes.ts wait-direct-capable --base-url https://entry.tmex.test --cookie-file /out/cookies-entry.json \
    --name self --timeout 60000
  dc_rc=$?
  set -e
  if [[ "${dc_rc}" -eq 0 ]]; then
    pass "8 direct_capable=true after native install"
  else
    fail "8 native files present but direct_capable did not flip: ${direct_out}"
  fi
fi

# ---------- scenario 9 TOTP ----------
set +e
totp_out="$(cli hub hub user totp "${USER_NAME}" 2>&1)"
totp_rc=$?
set -e
printf '%s\n' "${totp_out}" | tee "${OUT}/hub-user-totp.log"
TOTP_URI="$(printf '%s\n' "${totp_out}" | grep -Eo 'otpauth://totp/[^[:space:]]+' | tail -n1 || true)"
TOTP_SECRET=""
if [[ -n "${TOTP_URI}" ]]; then
  TOTP_SECRET="$(printf '%s\n' "${TOTP_URI}" | sed -n 's/.*[?&]secret=\([^&]*\).*/\1/p')"
fi
if [[ "${totp_rc}" -eq 0 && -n "${TOTP_SECRET}" ]]; then
  pass "9a hub user totp ${USER_NAME}"
else
  fail "9a hub user totp ${USER_NAME} (rc=${totp_rc})"
fi

set +e
missing_out="$(driver login.ts --base-url https://hub.tmex.test --username "${USER_NAME}" --password "${PASSWORD}" \
  --out /out/cookies-hub-totp-missing.json 2>&1)"
missing_rc=$?
set -e
printf '%s\n' "${missing_out}" | tee "${OUT}/login-totp-missing.log"
if [[ "${missing_rc}" -ne 0 ]] && echo "${missing_out}" | grep -q 'TOTP_REQUIRED'; then
  pass "9b login without totp fails TOTP_REQUIRED"
else
  fail "9b login without totp fails TOTP_REQUIRED (rc=${missing_rc})"
fi

set +e
wrong_out="$(driver login.ts --base-url https://hub.tmex.test --username "${USER_NAME}" --password "${PASSWORD}" \
  --totp 000000 --out /out/cookies-hub-totp-wrong.json 2>&1)"
wrong_rc=$?
set -e
printf '%s\n' "${wrong_out}" | tee "${OUT}/login-totp-wrong.log"
if [[ "${wrong_rc}" -ne 0 ]] && echo "${wrong_out}" | grep -q 'TOTP_INVALID'; then
  pass "9c login with wrong totp fails TOTP_INVALID"
else
  fail "9c login with wrong totp fails TOTP_INVALID (rc=${wrong_rc})"
fi

set +e
driver login.ts --base-url https://hub.tmex.test --username "${USER_NAME}" --password "${PASSWORD}" \
  --totp-secret "${TOTP_SECRET}" --out /out/cookies-hub.json
ok_totp_rc=$?
mode_totp="$(curl_hub https://hub.tmex.test/api/auth/mode)"
mode_totp_rc=$?
set -e
printf '%s\n' "${mode_totp}" | tee "${OUT}/auth-mode-totp.json"
if [[ "${ok_totp_rc}" -eq 0 && "${mode_totp_rc}" -eq 0 ]] \
  && echo "${mode_totp}" | grep -q '"totpEnabled":true'; then
  pass "9d login with totp succeeds, totpEnabled=true"
else
  fail "9d login with totp succeeds, totpEnabled=true (rc=${ok_totp_rc} mode=${mode_totp})"
fi

NEW_PASSWORD="${PASSWORD}-rot"
set +e
passwd_out="$(
  TMEX_PASSWORD_OLD="${PASSWORD}" PASSWORD="${NEW_PASSWORD}" \
    cli hub hub user passwd "${USER_NAME}" 2>&1
)"
passwd_rc=$?
set -e
printf '%s\n' "${passwd_out}" | tee "${OUT}/hub-user-passwd.log"
if [[ "${passwd_rc}" -eq 0 ]] && echo "${passwd_out}" | grep -q "password updated for ${USER_NAME}"; then
  pass "9e hub user passwd ${USER_NAME}"
  PASSWORD="${NEW_PASSWORD}"
else
  fail "9e hub user passwd ${USER_NAME} (rc=${passwd_rc})"
fi

set +e
driver login.ts --base-url https://hub.tmex.test --username "${USER_NAME}" --password "${PASSWORD}" \
  --out /out/cookies-hub.json
clear_rc=$?
mode_clear="$(curl_hub https://hub.tmex.test/api/auth/mode)"
mode_clear_rc=$?
set -e
printf '%s\n' "${mode_clear}" | tee "${OUT}/auth-mode-after-passwd.json"
if [[ "${clear_rc}" -eq 0 && "${mode_clear_rc}" -eq 0 ]] \
  && echo "${mode_clear}" | grep -q '"totpEnabled":false'; then
  pass "9f login after rotate-root without totp, totpEnabled=false"
else
  fail "9f login after rotate-root without totp (rc=${clear_rc} mode=${mode_clear})"
fi

write_report
log "report at ${OUT}/report.md"
if [[ "${FAILS}" -gt 0 ]]; then
  log "${FAILS} FAIL"
  exit 1
fi
log "all required scenarios passed"
exit 0
