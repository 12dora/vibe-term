// tmux server 放进受保护 slice、pane 负载留在 workload slice（宿主的 memory.high 只压负载）。
// 只对 Linux 本机设备生效；所有失败按类别 warn 一次，从不抛给调用方。

import {
  DEFAULT_PROTECTED_SLICE,
  DEFAULT_WORKLOAD_SLICE,
  cgroupProcsPath,
  isInsideSlice,
  isTmuxSpawnScope,
  isUnderRoot,
  isValidSliceName,
  paneScopeName,
  parsePidList,
  parseProcCgroup,
  parseStatusPpid,
  parseStatusUid,
  parseUserRoot,
  serverScopeName,
  unitOf,
} from './cgroup-paths';
import {
  PLACEMENT_TIMEOUT_MS,
  type PlacementIo,
  type StartScopeRequest,
  buildAttachScript,
  buildProbeScript,
  buildStartScopeScript,
  defaultPlacementIo,
  isUnitExistsError,
  parseProbeOutput,
} from './cgroup-placement-io';

export type PlacementProbe =
  | { supported: true; userRoot: string; ownCgroup: string }
  | { supported: false; reason: string };

export interface PlacementConfig {
  mode: 'auto' | 'off';
  protectedSlice: string;
  workloadSlice: string;
}

export type ServerPlacementAction = 'kept' | 'moved' | 'service' | 'skipped' | 'failed';

export interface ServerPlacement {
  action: ServerPlacementAction;
  cgroup: string | null;
}

export interface PlacementStatus {
  mode: string;
  workloadSlice: string;
  protectedSlice: string;
  movedServers: number;
  movedPanes: number;
}

const SEEN_PID_CAP = 4096;
const MOVE_POLL_INTERVAL_MS = 50;
const MOVE_POLL_STEPS = 30;

function sliceFromEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: string
): string {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (isValidSliceName(raw)) return raw;
  console.warn(`[tmux] placement ${key}=${raw} invalid, using ${fallback}`);
  return fallback;
}

export function readPlacementConfig(env: Record<string, string | undefined>): PlacementConfig {
  const raw = env.VIBETERM_CGROUP_PLACEMENT?.trim().toLowerCase();
  // 测试环境默认关闭：注入的假 tmux 返回的 pid 可能撞上宿主真实进程。
  const fallback = env.NODE_ENV === 'test' ? 'off' : 'auto';
  const mode = raw === 'off' || raw === 'auto' ? raw : fallback;
  return {
    mode,
    protectedSlice: sliceFromEnv(env, 'VIBETERM_PROTECTED_SLICE', DEFAULT_PROTECTED_SLICE),
    workloadSlice: sliceFromEnv(env, 'VIBETERM_WORKLOAD_SLICE', DEFAULT_WORKLOAD_SLICE),
  };
}

export class CgroupPlacement {
  readonly config: PlacementConfig;
  private probed: Promise<PlacementProbe> | null = null;
  private probeResult: PlacementProbe | null = null;
  private readonly warned = new Set<string>();
  private readonly infoLogged = new Set<string>();
  private readonly devices = new Set<string>();
  private readonly seenPanePids = new Set<number>();
  private readonly inflight = new Set<number>();
  private movedServers = 0;
  private movedPanes = 0;

  constructor(private readonly io: PlacementIo = defaultPlacementIo) {
    this.config = readPlacementConfig(io.env);
  }

  probePlacementSupport(): Promise<PlacementProbe> {
    this.probed ??= this.runProbe().then((result) => {
      this.probeResult = result;
      return result;
    });
    return this.probed;
  }

  modeLabel(): string {
    if (this.config.mode === 'off') return 'off';
    const probe = this.probeResult;
    if (!probe) return 'auto';
    return probe.supported ? 'auto' : `unsupported:${probe.reason}`;
  }

  getStatus(): PlacementStatus {
    return {
      mode: this.modeLabel(),
      workloadSlice: this.config.workloadSlice,
      protectedSlice: this.config.protectedSlice,
      movedServers: this.movedServers,
      movedPanes: this.movedPanes,
    };
  }

  enableDevice(deviceId: string): void {
    this.devices.add(deviceId);
  }

  disableDevice(deviceId: string): void {
    this.devices.delete(deviceId);
  }

  isDeviceEnabled(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }

  async protectTmuxServer(serverPid: number, socketPath: string): Promise<ServerPlacement> {
    try {
      return await this.protectServerInner(serverPid, socketPath);
    } catch (error) {
      this.warnOnce('server', `server pid=${serverPid}: ${describe(error)}`);
      return { action: 'failed', cgroup: null };
    }
  }

  async placePane(panePid: number): Promise<boolean> {
    if (!Number.isSafeInteger(panePid) || panePid <= 0 || this.inflight.has(panePid)) return false;
    this.inflight.add(panePid);
    try {
      return await this.placePaneInner(panePid);
    } catch (error) {
      this.warnOnce('pane', `pane pid=${panePid}: ${describe(error)}`);
      return false;
    } finally {
      this.inflight.delete(panePid);
    }
  }

  /** 只处理没见过的 pane pid；返回本次搬走的个数。 */
  async placePanes(deviceId: string, pids: readonly number[]): Promise<number> {
    if (!this.isDeviceEnabled(deviceId)) return 0;
    let moved = 0;
    for (const pid of pids) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || this.seenPanePids.has(pid)) continue;
      this.rememberPanePid(pid);
      if (await this.placePane(pid)) moved += 1;
    }
    return moved;
  }

  private rememberPanePid(pid: number): void {
    if (this.seenPanePids.size >= SEEN_PID_CAP) {
      const oldest = this.seenPanePids.values().next().value;
      if (oldest !== undefined) this.seenPanePids.delete(oldest);
    }
    this.seenPanePids.add(pid);
  }

  private async runProbe(): Promise<PlacementProbe> {
    if (this.config.mode === 'off') return { supported: false, reason: 'off' };
    if (this.io.platform !== 'linux') return { supported: false, reason: 'not-linux' };
    if (!(await this.io.exists('/sys/fs/cgroup/cgroup.controllers'))) {
      return { supported: false, reason: 'no-cgroup2' };
    }
    const ownCgroup = parseProcCgroup(await this.io.readFile('/proc/self/cgroup'));
    const userRoot = ownCgroup ? parseUserRoot(ownCgroup, this.io.uid) : null;
    if (!ownCgroup || !userRoot) return { supported: false, reason: 'not-user-manager' };
    const reason = await this.probeBus();
    if (reason !== 'ok') return { supported: false, reason };
    return { supported: true, userRoot, ownCgroup };
  }

  private async probeBus(): Promise<string> {
    try {
      const result = await this.io.runShell(buildProbeScript(), {
        timeoutMs: PLACEMENT_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) return 'probe-failed';
      return parseProbeOutput(result.stdout);
    } catch {
      return 'probe-failed';
    }
  }

  private async protectServerInner(
    serverPid: number,
    socketPath: string
  ): Promise<ServerPlacement> {
    const probe = await this.probePlacementSupport();
    if (!probe.supported) return { action: 'skipped', cgroup: null };
    const cgroup = await this.cgroupOf(serverPid);
    if (!cgroup) return { action: 'skipped', cgroup: null };
    const { userRoot } = probe;
    if (!isInsideSlice(cgroup, userRoot, this.config.workloadSlice)) {
      return { action: 'kept', cgroup };
    }
    const unit = unitOf(cgroup);
    if (unit.endsWith('.service')) {
      this.infoOnce(
        `service:${unit}`,
        `[tmux] placement server in ${unit} (${this.config.workloadSlice}); not moved, run that service with Slice=${this.config.protectedSlice}`
      );
      return { action: 'service', cgroup };
    }
    if (!unit.endsWith('.scope') || !(await this.ownedByUs(serverPid))) {
      return { action: 'skipped', cgroup };
    }
    const target = serverScopeName(socketPath);
    const moved = await this.moveIntoScope('server', {
      unit: target,
      slice: this.config.protectedSlice,
      pids: [serverPid],
      description: 'VibeTerm tmux server',
    });
    const landed = moved ? await this.waitForUnit('server', serverPid, target) : null;
    if (!landed) return { action: 'failed', cgroup };
    this.movedServers += 1;
    return { action: 'moved', cgroup: landed };
  }

  private async placePaneInner(panePid: number): Promise<boolean> {
    const probe = await this.probePlacementSupport();
    if (!probe.supported) return false;
    const status = await this.io.readFile(`/proc/${panePid}/status`);
    if (parseStatusUid(status) !== this.io.uid) return false;
    const cgroup = await this.cgroupOf(panePid);
    if (!cgroup || !isUnderRoot(cgroup, probe.userRoot)) return false;
    if (!isTmuxSpawnScope(unitOf(cgroup))) return false;
    if (isInsideSlice(cgroup, probe.userRoot, this.config.workloadSlice)) return false;
    const procsPath = cgroupProcsPath(cgroup);
    const pids = await this.ownedPids(parsePidList(await this.io.readFile(procsPath)));
    if (!pids.includes(panePid)) pids.unshift(panePid);
    const unit = paneScopeName();
    const launcher = parseStatusPpid(status) ?? 0;
    const moved = await this.startScope('pane', {
      unit,
      slice: this.config.workloadSlice,
      pids,
      description: `tmux child pane ${panePid} launched by process ${launcher}`,
    });
    if (!moved || !(await this.waitForUnit('pane', panePid, unit))) return false;
    await this.attachLeftovers(unit, procsPath);
    this.movedPanes += 1;
    return true;
  }

  /** StartTransientUnit 只是排了个 job：等第一个 pid 真进了新 unit 再往下走，返回新 cgroup。 */
  private async waitForUnit(kind: string, pid: number, unit: string): Promise<string | null> {
    for (let attempt = 0; attempt <= MOVE_POLL_STEPS; attempt += 1) {
      const cgroup = await this.cgroupOf(pid);
      if (cgroup && unitOf(cgroup) === unit) return cgroup;
      if (attempt < MOVE_POLL_STEPS) await this.io.sleep(MOVE_POLL_INTERVAL_MS);
    }
    this.warnOnce(
      `${kind}-wait`,
      `pid=${pid} not in ${unit} after ${MOVE_POLL_STEPS * MOVE_POLL_INTERVAL_MS} ms`
    );
    return null;
  }

  private async attachLeftovers(unit: string, procsPath: string): Promise<void> {
    const owned = await this.ownedPids(parsePidList(await this.io.readFile(procsPath)));
    const leftovers: number[] = [];
    for (const pid of owned) {
      const cgroup = await this.cgroupOf(pid);
      if (!cgroup || unitOf(cgroup) !== unit) leftovers.push(pid);
    }
    if (leftovers.length === 0) return;
    await this.runBus('pane-attach', buildAttachScript(unit, leftovers));
  }

  private async moveIntoScope(kind: string, request: StartScopeRequest): Promise<boolean> {
    const result = await this.runShellSafe(buildStartScopeScript(request));
    if (result.exitCode === 0) return true;
    if (isUnitExistsError(result.stderr)) {
      return this.runBus(`${kind}-attach`, buildAttachScript(request.unit, request.pids));
    }
    this.warnOnce(kind, `${request.unit}: ${failureText(result)}`);
    return false;
  }

  private startScope(kind: string, request: StartScopeRequest): Promise<boolean> {
    return this.runBus(kind, buildStartScopeScript(request));
  }

  private async runBus(kind: string, script: string): Promise<boolean> {
    const result = await this.runShellSafe(script);
    if (result.exitCode === 0) return true;
    this.warnOnce(kind, failureText(result));
    return false;
  }

  private async runShellSafe(
    script: string
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    try {
      return await this.io.runShell(script, { timeoutMs: PLACEMENT_TIMEOUT_MS });
    } catch (error) {
      return { exitCode: -1, stdout: '', stderr: describe(error) };
    }
  }

  private async cgroupOf(pid: number): Promise<string | null> {
    return parseProcCgroup(await this.io.readFile(`/proc/${pid}/cgroup`));
  }

  private async ownedByUs(pid: number): Promise<boolean> {
    return parseStatusUid(await this.io.readFile(`/proc/${pid}/status`)) === this.io.uid;
  }

  private async ownedPids(pids: number[]): Promise<number[]> {
    const owned: number[] = [];
    for (const pid of pids) {
      if (await this.ownedByUs(pid)) owned.push(pid);
    }
    return owned;
  }

  private warnOnce(kind: string, message: string): void {
    if (this.warned.has(kind)) return;
    this.warned.add(kind);
    console.warn(`[tmux] placement ${kind} failed: ${message}`);
  }

  private infoOnce(key: string, message: string): void {
    if (this.infoLogged.has(key)) return;
    this.infoLogged.add(key);
    console.info(message);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureText(result: { exitCode: number; stderr: string }): string {
  return result.stderr.trim() || `exit ${result.exitCode}`;
}

let shared: CgroupPlacement | null = null;

export function getCgroupPlacement(): CgroupPlacement {
  shared ??= new CgroupPlacement();
  return shared;
}

export function setCgroupPlacementForTest(next: CgroupPlacement | null): void {
  shared = next;
}
