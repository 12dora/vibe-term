// 只释放「本网关这只 tmux server」名下、限额仍是有限值的 tmux-spawn-*.scope。
// 归属：活着的 pane 的 ppid 必须是同一个 comm=tmux 的 server；scope 的 ControlGroup
// 与该 server 的 cgroup 落在同一 slice；并且 Description 里的 launcher pid 对得上，
// 或 cgroup.procs 里还有该 server 的后代。别的 tmux、别的 slice、非 tmux-spawn 一律不动。
// 限额仍开着时不扫：活 pane 每 tick 会校正，死 pane 留着上一次的有限上限，
// 比在用户还想限额时把它们写成 infinity 安全。关掉或三项都是 0 才释放。

import { HOST_SHELL_MAX_OUTPUT_BYTES, HOST_SHELL_TIMEOUT_MS } from './constants';
import { releaseScopeLimit } from './tracker-ops';
import type { MemoryPaneRef, PaneMemoryState } from './tracker-ops';
import type { HostShellRunner, PaneScopeSample } from './types';
import { withUserBus } from './user-bus';

export const ORPHAN_SWEEP_MARK = 'VTORPHAN_SWEEP';

const SCOPE_NAME = /^tmux-spawn-[A-Za-z0-9_-]+\.scope$/;
const LOUD_REASONS = new Set(['list-failed', 'mixed-server', 'no-server-cgroup']);

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
prop_of() {
  printf '%s\\n' "$1" | sed -n "s/^$2=//p" | head -n 1 | tr '\\t' ' '
}
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
printf '%s\\n' 'VTORPHAN 1 ok'
printf 'SERVER\\t%s\\t%s\\n' "$server_pid" "$server_cg"
printf '%s\\n' "$units" | while IFS= read -r line || [ -n "$line" ]; do
  line=$(printf '%s' "$line" | sed 's/^[[:space:]]*//')
  name=\${line%% *}
  case "$name" in
    tmux-spawn-*.scope) ;;
    *) continue ;;
  esac
  show=$(systemctl --user show "$name" -p Description -p MemoryHigh -p MemoryMax -p MemorySwapMax -p ControlGroup --no-pager 2>/dev/null) || continue
  launcher=$(prop_of "$show" Description)
  launcher=$(printf '%s\\n' "$launcher" | sed -n 's/.*launched by process \\([0-9][0-9]*\\).*/\\1/p' | head -n 1)
  cg=$(prop_of "$show" ControlGroup)
  high=$(prop_of "$show" MemoryHigh)
  max=$(prop_of "$show" MemoryMax)
  swap=$(prop_of "$show" MemorySwapMax)
  [ -n "$launcher" ] || launcher=-
  [ -n "$cg" ] || cg=-
  [ -n "$high" ] || high=-
  [ -n "$max" ] || max=-
  [ -n "$swap" ] || swap=-
  tree=0
  if [ "$launcher" != "$server_pid" ] && tree_owns "$cg"; then
    tree=1
  fi
  printf 'UNIT\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$name" "$launcher" "$cg" "$high" "$max" "$swap" "$tree"
done
`;

export function isOrphanSweepScript(script: string): boolean {
  return script.includes(ORPHAN_SWEEP_MARK);
}

export function buildOrphanSweepScript(panePids: readonly number[]): string {
  const lines = panePids.filter((pid) => Number.isInteger(pid) && pid > 0);
  const body = lines.join('\n');
  return withUserBus(`${SWEEP_BEFORE}${body}${body ? '\n' : ''}${SWEEP_AFTER}`);
}

export interface ListedScope {
  scope: string;
  launcherPid: number | null;
  controlGroup: string;
  high: number;
  max: number;
  swapMax: number;
  treeHit: boolean;
}

export interface OrphanSweepParse {
  ok: boolean;
  reason: string;
  serverPid: number | null;
  serverCgroup: string;
  units: ListedScope[];
}

export function scopeParent(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  if (slash <= 0) return '';
  return trimmed.slice(0, slash);
}

export function sameMemorySlice(controlGroup: string, serverCgroup: string): boolean {
  const parent = scopeParent(controlGroup);
  if (!parent || !serverCgroup) return false;
  const server = serverCgroup.replace(/\/+$/, '');
  const serverParent = scopeParent(server);
  if (parent === serverParent || parent === server) return true;
  return server.startsWith(`${parent}/`);
}

export function orphanOwnedByServer(
  unit: ListedScope,
  serverPid: number,
  serverCgroup: string
): boolean {
  if (!SCOPE_NAME.test(unit.scope)) return false;
  if (!controlGroupNamesScope(unit.controlGroup, unit.scope)) return false;
  if (!sameMemorySlice(unit.controlGroup, serverCgroup)) return false;
  if (unit.launcherPid === serverPid) return true;
  return unit.treeHit;
}

function controlGroupNamesScope(controlGroup: string, scope: string): boolean {
  return controlGroup === scope || controlGroup.endsWith(`/${scope}`);
}

export function parseOrphanSweep(stdout: string): OrphanSweepParse {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const header = lines.find((line) => line.startsWith('VTORPHAN '));
  const parsed = parseHeader(header);
  if (!parsed.ok) return emptyParse(parsed.reason);
  const server = parseServer(lines);
  if (!server) return emptyParse('no-server');
  return {
    ok: true,
    reason: 'ok',
    serverPid: server.pid,
    serverCgroup: server.cgroup,
    units: lines.filter((line) => line.startsWith('UNIT\t')).flatMap(parseUnit),
  };
}

function emptyParse(reason: string): OrphanSweepParse {
  return { ok: false, reason, serverPid: null, serverCgroup: '', units: [] };
}

function parseHeader(header: string | undefined): { ok: boolean; reason: string } {
  if (!header) return { ok: false, reason: 'no-header' };
  const match = /^VTORPHAN ([01]) ([a-z0-9-]+)$/.exec(header);
  if (!match) return { ok: false, reason: 'bad-header' };
  if (match[1] !== '1') return { ok: false, reason: match[2] ?? 'rejected' };
  return { ok: true, reason: 'ok' };
}

function parseServer(lines: readonly string[]): { pid: number; cgroup: string } | null {
  const line = lines.find((row) => row.startsWith('SERVER\t'));
  if (!line) return null;
  const fields = line.split('\t');
  if (fields.length < 3) return null;
  if (!/^\d+$/.test(fields[1] ?? '')) return null;
  const pid = Number.parseInt(fields[1] ?? '', 10);
  const cgroup = fields.slice(2).join('\t');
  if (!Number.isSafeInteger(pid) || pid <= 0 || !cgroup) return null;
  return { pid, cgroup };
}

function parseUnit(line: string): ListedScope[] {
  const fields = line.split('\t');
  if (fields.length !== 8) return [];
  const scope = fields[1] ?? '';
  if (!SCOPE_NAME.test(scope)) return [];
  const high = parseMemoryProperty(fields[4] ?? '');
  const max = parseMemoryProperty(fields[5] ?? '');
  const swapMax = parseMemoryProperty(fields[6] ?? '');
  if (high === null || max === null || swapMax === null) return [];
  return [
    {
      scope,
      launcherPid: parseLauncher(fields[2] ?? ''),
      controlGroup: fields[3] ?? '',
      high,
      max,
      swapMax,
      treeHit: fields[7] === '1',
    },
  ];
}

function parseLauncher(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const pid = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return pid;
}

function parseMemoryProperty(raw: string): number | null {
  if (raw === '-' || raw === '' || raw === 'infinity' || raw === 'inf' || raw === 'max') return 0;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

export interface OrphanSweepOptions {
  host: HostShellRunner;
  deviceId: string;
  now: number;
  panes: readonly MemoryPaneRef[];
  liveScopes: readonly string[];
  states: Map<string, PaneMemoryState>;
  warned: Set<string>;
}

export async function sweepReleaseOrphans(opts: OrphanSweepOptions): Promise<void> {
  try {
    await releaseListedOrphans(opts);
  } catch (error) {
    console.warn(
      `[vibeterm][window-memory] orphan sweep failed device=${opts.deviceId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function releaseListedOrphans(opts: OrphanSweepOptions): Promise<void> {
  const script = buildOrphanSweepScript(positivePids(opts.panes));
  const result = await opts.host.runHostShell(script, {
    timeoutMs: HOST_SHELL_TIMEOUT_MS,
    maxOutputBytes: HOST_SHELL_MAX_OUTPUT_BYTES,
  });
  if (result.exitCode !== 0) {
    noteLoud(opts, 'list-failed');
    return;
  }
  const parsed = parseOrphanSweep(result.stdout);
  if (!parsed.ok || parsed.serverPid === null) {
    noteLoud(opts, parsed.reason);
    return;
  }
  const releasing = await releaseOwned(opts, parsed);
  for (const scope of [...opts.states.keys()]) {
    if (!releasing.has(scope)) opts.states.delete(scope);
  }
}

async function releaseOwned(
  opts: OrphanSweepOptions,
  parsed: OrphanSweepParse
): Promise<Set<string>> {
  const live = new Set(opts.liveScopes);
  const releasing = new Set<string>();
  const serverPid = parsed.serverPid ?? 0;
  for (const unit of parsed.units) {
    if (live.has(unit.scope)) continue;
    if (!unitLimited(unit)) continue;
    if (!orphanOwnedByServer(unit, serverPid, parsed.serverCgroup)) continue;
    releasing.add(unit.scope);
    await releaseOne(opts, unit);
  }
  return releasing;
}

async function releaseOne(opts: OrphanSweepOptions, unit: ListedScope): Promise<void> {
  const state = opts.states.get(unit.scope) ?? newOrphanState(unit.scope);
  opts.states.set(unit.scope, state);
  state.sample = sampleOf(unit);
  if (state.desiredKey === '') {
    console.info(
      `[vibeterm][window-memory] orphan scope still limited device=${opts.deviceId} scope=${unit.scope}`
    );
  }
  await releaseScopeLimit(opts.host, opts.deviceId, state, opts.now);
}

function noteLoud(opts: OrphanSweepOptions, reason: string): void {
  if (!LOUD_REASONS.has(reason) || opts.warned.has(reason)) return;
  opts.warned.add(reason);
  console.warn(`[vibeterm][window-memory] orphan sweep ${reason} device=${opts.deviceId}`);
}

function positivePids(panes: readonly MemoryPaneRef[]): number[] {
  const pids: number[] = [];
  for (const pane of panes) {
    if (Number.isInteger(pane.pid) && (pane.pid ?? 0) > 0) pids.push(pane.pid as number);
  }
  return pids;
}

function unitLimited(unit: ListedScope): boolean {
  return unit.high > 0 || unit.max > 0 || unit.swapMax > 0;
}

function newOrphanState(scope: string): PaneMemoryState {
  return {
    paneId: `orphan:${scope}`,
    windowId: '',
    windowName: '',
    scope,
    sample: null,
    oomKills: 0,
    applyAttempts: 0,
    applyFailedAt: null,
    desiredKey: '',
    lastStderr: '',
    giveUpLogged: false,
  };
}

function sampleOf(unit: ListedScope): PaneScopeSample {
  return {
    paneId: `orphan:${unit.scope}`,
    pid: 0,
    scope: unit.scope,
    current: 0,
    high: unit.high,
    max: unit.max,
    swapMax: unit.swapMax,
    oomKills: 0,
    managed: true,
    source: 'cgroup',
  };
}
