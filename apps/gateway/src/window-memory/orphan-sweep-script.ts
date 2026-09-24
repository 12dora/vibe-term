// 孤儿清扫脚本：一次 systemctl show 拉完全部候选，先看限额再走进程树。
// 活着的 pane scope 由 pane 循环处理，这里直接跳过。
// case 模式必须写死在脚本里：POSIX sh 把参数展开出来的 | 当成字面字符。

import { withUserBus } from './user-bus';

export const ORPHAN_SWEEP_MARK = 'VTORPHAN_SWEEP';
export const SCOPE_NAME = /^tmux-spawn-[A-Za-z0-9_-]+\.scope$/;

const SWEEP_BEFORE = `# ${ORPHAN_SWEEP_MARK}
if ! command -v systemctl >/dev/null 2>&1; then
  printf '%s\\n' 'VTORPHAN 0 no-systemctl'
  exit 0
fi
server_pid=
while IFS= read -r pane_pid || [ -n "$pane_pid" ]; do
  [ -n "$pane_pid" ] || continue
  case "$pane_pid" in
    *[!0-9]*) continue ;;
  esac
  [ "$pane_pid" -gt 0 ] || continue
  ppid=$(ps -o ppid= -p "$pane_pid" 2>/dev/null | tr -d '[:space:]')
  [ -n "$ppid" ] || continue
  comm=$(ps -o comm= -p "$ppid" 2>/dev/null | tr -d '[:space:]')
  case "$comm" in
    tmux|tmux:*|*/tmux) ;;
    *) continue ;;
  esac
  if [ -z "$server_pid" ]; then
    server_pid=$ppid
  elif [ "$server_pid" != "$ppid" ]; then
    printf '%s\\n' 'VTORPHAN 0 mixed-server'
    exit 0
  fi
done <<'VT_PIDS'
`;

const SWEEP_AFTER = `VT_PIDS
if [ -z "$server_pid" ]; then
  printf '%s\\n' 'VTORPHAN 0 no-server'
  exit 0
fi
server_cg=$(sed -n 's/^0:://p' "/proc/\${server_pid}/cgroup" | head -n 1)
if [ -z "$server_cg" ]; then
  printf '%s\\n' 'VTORPHAN 0 no-server-cgroup'
  exit 0
fi
units=$(systemctl --user list-units 'tmux-spawn-*.scope' --all --no-legend --no-pager 2>/dev/null) || {
  printf '%s\\n' 'VTORPHAN 0 list-failed'
  exit 0
}
names=
while IFS= read -r line || [ -n "$line" ]; do
  line=$(printf '%s' "$line" | sed 's/^[[:space:]]*//')
  name=\${line%% *}
  case "$name" in
    tmux-spawn-*.scope) ;;
    *) continue ;;
  esac
VT_LIVE_SKIP
  names="$names $name"
done <<ENDUNITS
\${units}
ENDUNITS
show=
if [ -n "$names" ]; then
  set -f
  show=$(systemctl --user show $names -p Id -p Description -p MemoryHigh -p MemoryMax -p MemorySwapMax -p ControlGroup --no-pager 2>/dev/null) || show=
  set +f
fi
tree_owns() {
  _cg="$1"
  [ -n "$_cg" ] || return 1
  case "$_cg" in
    /*) _procs="/sys/fs/cgroup\${_cg}/cgroup.procs" ;;
    *) _procs="/sys/fs/cgroup/\${_cg}/cgroup.procs" ;;
  esac
  [ -r "$_procs" ] || return 1
  _n=0
  while IFS= read -r _p || [ -n "$_p" ]; do
    [ -n "$_p" ] || continue
    _n=$((_n + 1))
    [ "$_n" -le 32 ] || break
    _walk="$_p"
    _d=0
    while [ "$_d" -lt 32 ]; do
      [ "$_walk" = "$server_pid" ] && return 0
      [ -z "$_walk" ] || [ "$_walk" = 0 ] || [ "$_walk" = 1 ] && break
      _walk=$(ps -o ppid= -p "$_walk" 2>/dev/null | tr -d '[:space:]')
      _d=$((_d + 1))
    done
  done < "$_procs"
  return 1
}
mem_limited() {
  case "$1" in
    ''|infinity|inf|max|-) return 1 ;;
  esac
  case "$1" in
    *[!0-9]*) return 1 ;;
  esac
  [ "\${#1}" -gt 16 ] && return 1
  [ "$1" -gt 0 ]
}
flush_unit() {
  [ -n "$id" ] || return 0
  case "$id" in
    tmux-spawn-*.scope) ;;
    *) id=; desc=; high=; maxmem=; swap=; cg=; return 0 ;;
  esac
  limited=0
  if mem_limited "$high" || mem_limited "$maxmem" || mem_limited "$swap"; then
    limited=1
  fi
  if [ "$limited" != 1 ]; then
    id=; desc=; high=; maxmem=; swap=; cg=
    return 0
  fi
  launcher=$(printf '%s\\n' "$desc" | sed -n 's/.*launched by process \\([0-9][0-9]*\\).*/\\1/p' | head -n 1)
  tree=0
  if [ "$launcher" != "$server_pid" ]; then
    if tree_owns "$cg"; then
      tree=1
    fi
  fi
  alive=0
  if [ -n "$launcher" ] && [ -d "/proc/$launcher" ]; then
    alive=1
  fi
  case "$cg" in
    /*) _swapf="/sys/fs/cgroup\${cg}/memory.swap.max" ;;
    '') _swapf= ;;
    *) _swapf="/sys/fs/cgroup/\${cg}/memory.swap.max" ;;
  esac
  if [ -n "$_swapf" ] && [ ! -r "$_swapf" ]; then
    swap=?
  fi
  [ -n "$launcher" ] || launcher=-
  [ -n "$cg" ] || cg=-
  [ -n "$high" ] || high=-
  [ -n "$maxmem" ] || maxmem=-
  [ -n "$swap" ] || swap=-
  printf 'UNIT\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$id" "$launcher" "$cg" "$high" "$maxmem" "$swap" "$tree" "$alive"
  id=; desc=; high=; maxmem=; swap=; cg=
}
printf '%s\\n' 'VTORPHAN 1 ok'
printf 'SERVER\\t%s\\t%s\\n' "$server_pid" "$server_cg"
printf '%s\\n' "$show" | {
  id=
  desc=
  high=
  maxmem=
  swap=
  cg=
  while IFS= read -r line || [ -n "$line" ]; do
    if [ -z "$line" ]; then
      flush_unit
      continue
    fi
    key=\${line%%=*}
    val=\${line#*=}
    case "$key" in
      Id) id=$val ;;
      Description) desc=$val ;;
      MemoryHigh) high=$val ;;
      MemoryMax) maxmem=$val ;;
      MemorySwapMax) swap=$val ;;
      ControlGroup) cg=$val ;;
    esac
  done
  flush_unit
}
`;

export function isOrphanSweepScript(script: string): boolean {
  return script.includes(ORPHAN_SWEEP_MARK);
}

export function buildOrphanSweepScript(
  panePids: readonly number[],
  liveScopes: readonly string[] = []
): string {
  const lines = panePids.filter((pid) => Number.isInteger(pid) && pid > 0);
  const body = lines.join('\n');
  const live = liveScopes.filter((scope) => SCOPE_NAME.test(scope));
  const skip = liveScopeSkip(live);
  const after = SWEEP_AFTER.replace('VT_LIVE_SKIP\n', skip);
  const pids = `${SWEEP_BEFORE}${body}${body ? '\n' : ''}${after}`;
  return withUserBus(pids);
}

function liveScopeSkip(scopes: readonly string[]): string {
  if (scopes.length === 0) return '';
  return `  case "$name" in\n    ${scopes.join('|')}) continue ;;\n  esac\n`;
}
