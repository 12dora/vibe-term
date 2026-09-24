// 只释放「本网关这只 tmux server」名下、且限额字节数等于 VibeTerm 套过的某一档的孤儿 scope。
// Description 里的 launcher pid 对上 server 就够了，不要求同一个 slice。
// 进程树兜底仍然要求同一个 slice。对不上的有限 scope 每个名字打一行原因，不重复刷。

import type { AppliedLimitTriple } from './applied-triples';
import { observedMatchesAny } from './applied-triples';
import { HOST_SHELL_MAX_OUTPUT_BYTES, HOST_SHELL_TIMEOUT_MS } from './constants';
import {
  ORPHAN_SWEEP_MARK,
  SCOPE_NAME,
  buildOrphanSweepScript,
  isOrphanSweepScript,
} from './orphan-sweep-script';
import { type PaneMemoryState, type PlannedWrite, decideRelease } from './tracker-ops';
import type { MemoryPaneRef } from './tracker-ops';
import type { HostShellRunner, PaneScopeSample } from './types';

export { ORPHAN_SWEEP_MARK, buildOrphanSweepScript, isOrphanSweepScript };

const LOUD_REASONS = new Set(['list-failed', 'mixed-server', 'no-server-cgroup']);

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

export function orphanRejectReason(
  unit: ListedScope,
  serverPid: number,
  serverCgroup: string
): string | null {
  if (!SCOPE_NAME.test(unit.scope)) return 'name';
  if (!controlGroupNamesScope(unit.controlGroup, unit.scope)) return 'cgroup';
  if (unit.launcherPid === serverPid) return null;
  if (!sameMemorySlice(unit.controlGroup, serverCgroup)) return 'slice';
  if (unit.treeHit) return null;
  if (unit.launcherPid === null) return 'launcher';
  return 'no-tree';
}

export function orphanOwnedByServer(
  unit: ListedScope,
  serverPid: number,
  serverCgroup: string
): boolean {
  return orphanRejectReason(unit, serverPid, serverCgroup) === null;
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
  if (raw.length > 16) return 0;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) return 0;
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
  triples: readonly AppliedLimitTriple[];
}

export async function sweepReleaseOrphans(opts: OrphanSweepOptions): Promise<PlannedWrite[]> {
  try {
    return await planListedOrphans(opts);
  } catch (error) {
    console.warn(
      `[vibeterm][window-memory] orphan sweep failed device=${opts.deviceId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return [];
  }
}

async function planListedOrphans(opts: OrphanSweepOptions): Promise<PlannedWrite[]> {
  const script = buildOrphanSweepScript(positivePids(opts.panes), opts.liveScopes);
  const result = await opts.host.runHostShell(script, {
    timeoutMs: HOST_SHELL_TIMEOUT_MS,
    maxOutputBytes: HOST_SHELL_MAX_OUTPUT_BYTES,
  });
  if (result.exitCode !== 0) {
    noteLoud(opts, 'list-failed');
    return [];
  }
  const parsed = parseOrphanSweep(result.stdout);
  if (!parsed.ok || parsed.serverPid === null) {
    noteLoud(opts, parsed.reason);
    return [];
  }
  return planOwned(opts, parsed);
}

function planOwned(opts: OrphanSweepOptions, parsed: OrphanSweepParse): PlannedWrite[] {
  const live = new Set(opts.liveScopes);
  const releasing = new Set<string>();
  const planned: PlannedWrite[] = [];
  const serverPid = parsed.serverPid ?? 0;
  for (const unit of parsed.units) {
    const write = planUnit(opts, unit, live, serverPid, parsed.serverCgroup);
    if (!write.keep) continue;
    releasing.add(unit.scope);
    if (write.plan) planned.push(write.plan);
  }
  for (const scope of [...opts.states.keys()]) {
    if (!releasing.has(scope)) opts.states.delete(scope);
  }
  return planned;
}

function planUnit(
  opts: OrphanSweepOptions,
  unit: ListedScope,
  live: Set<string>,
  serverPid: number,
  serverCgroup: string
): { keep: boolean; plan: PlannedWrite | null } {
  if (live.has(unit.scope) || !unitLimited(unit)) return { keep: false, plan: null };
  const reason = orphanRejectReason(unit, serverPid, serverCgroup);
  if (reason) {
    noteReject(opts, unit.scope, reason);
    return { keep: false, plan: null };
  }
  if (!observedMatchesAny(unit, opts.triples)) return { keep: false, plan: null };
  const state = opts.states.get(unit.scope) ?? newOrphanState(unit.scope);
  opts.states.set(unit.scope, state);
  state.sample = sampleOf(unit);
  if (state.desiredKey === '') noteStillLimited(opts, unit.scope);
  return { keep: true, plan: decideRelease(state, opts.triples, opts.now, opts.deviceId) };
}

function noteReject(opts: OrphanSweepOptions, scope: string, reason: string): void {
  const key = `reject:${scope}`;
  if (opts.warned.has(key)) return;
  opts.warned.add(key);
  console.info(
    `[vibeterm][window-memory] orphan scope rejected device=${opts.deviceId} scope=${scope} reason=${reason}`
  );
}

function noteStillLimited(opts: OrphanSweepOptions, scope: string): void {
  console.info(
    `[vibeterm][window-memory] orphan scope still limited device=${opts.deviceId} scope=${scope}`
  );
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
    releaseUnverified: false,
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
