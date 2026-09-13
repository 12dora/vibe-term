import { DEFAULT_PEER_PORT, DEFAULT_RTC_PORT_RANGE, type PortRange } from '@vibeterm/shared/net';
import {
  type PeerReachVerdict,
  nodeIdPrefix8,
  normalizePeerReach,
  normalizePeerReachEpoch,
} from '@vibeterm/shared/relay';
import type { UserStore } from '../auth/user-store';
import { config as gatewayConfig } from '../config';
import {
  classifyRemoteAddress,
  hostFromWsUrl,
  isCgnatIpv4,
  isFakeIpv4,
  isFakeIpv4PeerEndpoint,
} from './address-class';
import { logLine } from './mesh-log';
import type { MeshNodeDirectFailure, MeshNodeDto, MeshPortReach } from './node-list-projection';
import type { PeerPathRttMemory } from './peer-path-rtt';
import {
  type SelfPortRoles,
  derivedSelfPortRows,
  localRelaySnapshotKey,
} from './port-reach-derived';
import {
  PORT_PROBE_DEADLINE_MS,
  type TcpProbeResult,
  type TcpProbeVerdict,
  probeTcpConnect,
} from './port-reach-probe';
import { membersProbeSnapshot, resetTurnReachForTest, setTurnReachNow } from './port-reach-turn';
import { matchingTurnProbe } from './rtc/stun-effective';
import { stunProbeSnapshot } from './rtc/stun-probe';
import { ensureTcpSamplingTrust } from './tcp-sampling-trust';

export type { MembersProbeSnapshot } from './port-reach-turn';
export { TURN_REPORT_TTL_MS, ingestTurnOk, membersProbeSnapshot } from './port-reach-turn';

export const PORT_PROBE_CADENCE_MS = 5 * 60 * 1_000;
export const PORT_PROBE_TICK_MS = 30_000;
export const PORT_PROBE_CONNECTS = 3;

/** 三口并发的裁决合并：任一成功即 ok；全失败时只有全部 refused 才算 refused，否则按 timeout（被过滤）处理。 */
export function aggregateProbeVerdicts(verdicts: readonly TcpProbeVerdict[]): TcpProbeVerdict {
  if (verdicts.some((verdict) => verdict === 'ok')) return 'ok';
  return verdicts.length > 0 && verdicts.every((verdict) => verdict === 'refused')
    ? 'refused'
    : 'timeout';
}
export const DC_HISTORY_MS = 24 * 60 * 60 * 1_000;
export const PEER_REPORT_TTL_MS = 30 * 60 * 1_000;
export const GATHER_BLOCKED_WINDOW = 3;

export type MeshPortReachStatus = MeshPortReach['status'];
export type MeshPortReachCode = NonNullable<MeshPortReach['code']>;

type ProbeFn = (host: string, port: number, deadlineMs?: number) => Promise<TcpProbeResult>;

type PeerProbeSlot = {
  lastVerdict: TcpProbeVerdict | null;
  consecutiveFails: number;
  status: MeshPortReachStatus;
  code?: MeshPortReachCode;
  checkedAt?: number;
  lastAt: number;
};

type DcSlot = { lastUpAt: number; up: boolean };

type GatherSample = { srflx: boolean; at: number };

type PeerReport = {
  reporter: string;
  verdict: PeerReachVerdict;
  at: number;
  timeoutStrikes: number;
};

type PortReachState = {
  probes: Map<string, PeerProbeSlot>;
  dc: Map<string, DcSlot>;
  reports: Map<string, PeerReport>;
  gathers: GatherSample[];
  srflxEver: boolean;
  dcEver: boolean;
  peerServerListening: boolean | null;
  stunOk: boolean | null;
  selfEpoch: number;
  seenEpochs: Map<string, number>;
  forceProbe: Set<string>;
  roles: SelfPortRoles | null;
  httpsUplink: boolean;
  onSelfEpochBump: (() => void) | null;
  now: () => number;
  probeFn: ProbeFn;
  trust: (host: string, now: number, probe: ProbeFn) => Promise<boolean>;
};

const state: PortReachState = createState();

function createState(): PortReachState {
  return {
    probes: new Map(),
    dc: new Map(),
    reports: new Map(),
    gathers: [],
    srflxEver: false,
    dcEver: false,
    peerServerListening: null,
    stunOk: null,
    selfEpoch: 0,
    seenEpochs: new Map(),
    forceProbe: new Set(),
    roles: null,
    httpsUplink: false,
    onSelfEpochBump: null,
    now: Date.now,
    probeFn: probeTcpConnect,
    trust: (host, now, probe) => ensureTcpSamplingTrust(host, now, probe, (line) => logLine(line)),
  };
}

export function resetPortReachForTest(opts?: {
  now?: () => number;
  probeFn?: ProbeFn;
  trust?: (host: string, now: number, probe: ProbeFn) => Promise<boolean>;
}): void {
  const next = createState();
  if (opts?.now) next.now = opts.now;
  if (opts?.probeFn) next.probeFn = opts.probeFn;
  if (opts?.trust) next.trust = opts.trust;
  resetTurnReachForTest(next.now);
  state.probes = next.probes;
  state.dc = next.dc;
  state.reports = next.reports;
  state.gathers = next.gathers;
  state.srflxEver = next.srflxEver;
  state.dcEver = next.dcEver;
  state.peerServerListening = next.peerServerListening;
  state.stunOk = next.stunOk;
  state.selfEpoch = next.selfEpoch;
  state.seenEpochs = next.seenEpochs;
  state.forceProbe = next.forceProbe;
  state.roles = next.roles;
  state.httpsUplink = next.httpsUplink;
  state.onSelfEpochBump = next.onSelfEpochBump;
  state.now = next.now;
  state.probeFn = next.probeFn;
  state.trust = next.trust;
}

export function setStunOkForTest(ok: boolean | null): void {
  state.stunOk = ok;
}

export function notePeerServerBind(listening: boolean | null): void {
  state.peerServerListening = listening;
}

export function notePeerTransport(nodeId: string, transport: string | null): void {
  if (transport === 'dc') {
    state.dcEver = true;
    state.dc.set(nodeId, { lastUpAt: state.now(), up: true });
    return;
  }
  const prev = state.dc.get(nodeId);
  if (prev) state.dc.set(nodeId, { lastUpAt: prev.lastUpAt, up: false });
}

export function noteRtcGather(input: { srflx: number }): void {
  const had = input.srflx > 0;
  if (had) state.srflxEver = true;
  state.gathers.push({ srflx: had, at: state.now() });
  if (state.gathers.length > GATHER_BLOCKED_WINDOW * 4) {
    state.gathers.splice(0, state.gathers.length - GATHER_BLOCKED_WINDOW * 2);
  }
}

export function ingestPeerReachMap(
  reporterId: string,
  peerReach: unknown,
  selfNodeId: string
): void {
  const parsed = normalizePeerReach(peerReach);
  const at = state.now();
  const selfKey = nodeIdPrefix8(selfNodeId);
  if (parsed) {
    const verdict = parsed[selfKey];
    if (verdict) {
      const prev = state.reports.get(reporterId);
      const timeoutStrikes = verdict === 'timeout' ? (prev?.timeoutStrikes ?? 0) + 1 : 0;
      state.reports.set(reporterId, { reporter: reporterId, verdict, at, timeoutStrikes });
    }
  }
}

export function isProbeablePeerEndpoint(url: string): boolean {
  if (isFakeIpv4PeerEndpoint(url)) return false;
  const host = hostFromWsUrl(url);
  if (!host) return false;
  if (isFakeIpv4(host) || isCgnatIpv4(host)) return false;
  if (classifyRemoteAddress(host) === 'lan') return false;
  return true;
}

export function probeTargetOf(url: string): { host: string; port: number } | null {
  if (!isProbeablePeerEndpoint(url)) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'wss:' ? 443 : 80;
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
  } catch {
    return null;
  }
}

function firstProbeableTarget(endpoints: readonly string[]): { host: string; port: number } | null {
  for (const url of endpoints) {
    const target = probeTargetOf(url);
    if (target) return target;
  }
  return null;
}

function applyProbeVerdict(
  slot: PeerProbeSlot,
  verdict: TcpProbeVerdict,
  at: number
): PeerProbeSlot {
  if (verdict === 'ok') {
    return { lastVerdict: verdict, consecutiveFails: 0, status: 'open', checkedAt: at, lastAt: at };
  }
  const consecutiveFails = slot.consecutiveFails + 1;
  const code: MeshPortReachCode = verdict === 'refused' ? 'peer_refused' : 'peer_timeout';
  // refused：对端主机可达但口关闭，一次即可定论；timeout 可能是瞬时丢包，要两次。
  if (verdict === 'refused' || consecutiveFails >= 2) {
    return {
      lastVerdict: verdict,
      consecutiveFails,
      status: 'blocked',
      code,
      checkedAt: at,
      lastAt: at,
    };
  }
  return {
    lastVerdict: verdict,
    consecutiveFails,
    status: slot.status,
    code: slot.status === 'blocked' ? slot.code : undefined,
    checkedAt: at,
    lastAt: at,
  };
}

export async function probePeerEndpoints(
  nodeId: string,
  endpoints: readonly string[],
  opts?: { force?: boolean; pathRttMemory?: PeerPathRttMemory }
): Promise<PeerProbeSlot> {
  const at = state.now();
  const prev = state.probes.get(nodeId) ?? {
    lastVerdict: null,
    consecutiveFails: 0,
    status: 'unknown' as const,
    lastAt: 0,
  };
  if (shouldSkipCadence(opts?.force, prev.lastAt, at, nodeId)) return prev;
  const target = firstProbeableTarget(endpoints);
  if (!target) {
    const skipped: PeerProbeSlot = {
      lastVerdict: prev.lastVerdict,
      consecutiveFails: prev.consecutiveFails,
      status: 'unknown',
      lastAt: at,
      checkedAt: at,
    };
    state.probes.set(nodeId, skipped);
    return skipped;
  }
  const results = await Promise.all(
    Array.from({ length: PORT_PROBE_CONNECTS }, () =>
      state.probeFn(target.host, target.port, PORT_PROBE_DEADLINE_MS)
    )
  );
  const trusted =
    opts?.pathRttMemory && results.some((result) => result.verdict === 'ok')
      ? await state.trust(target.host, at, state.probeFn)
      : false;
  for (const result of results) {
    if (!trusted || result.verdict !== 'ok' || result.connectMs === null) continue;
    if (result.remoteAddress && isFakeIpv4(result.remoteAddress)) continue;
    opts?.pathRttMemory?.record(nodeId, { kind: 'tcp-connect', rttMs: result.connectMs });
  }
  const verdict = aggregateProbeVerdicts(results.map((result) => result.verdict));
  const next = applyProbeVerdict(prev, verdict, at);
  state.probes.set(nodeId, next);
  return next;
}

export function peerReachPayload(
  selfNodeId: string,
  peerIds: readonly string[]
): Record<string, PeerReachVerdict> {
  const out: Record<string, PeerReachVerdict> = {};
  for (const id of peerIds) {
    if (id === selfNodeId) continue;
    if (Object.keys(out).length >= 32) break;
    const slot = state.probes.get(id);
    if (!slot?.lastVerdict) continue;
    out[nodeIdPrefix8(id)] = slot.lastVerdict;
  }
  return out;
}

export function turnOkForConfigured(configured: unknown): boolean | undefined {
  const probe = matchingTurnProbe(configured);
  if (!probe) return undefined;
  return probe.ok;
}

function stunProbesOk(): boolean {
  if (state.stunOk != null) return state.stunOk;
  return stunProbeSnapshot().some((row) => row.ok);
}

function selfRtcStatus(): Pick<MeshPortReach, 'status' | 'code' | 'checkedAt'> {
  if (state.srflxEver || state.dcEver) return { status: 'open' };
  const window = state.gathers.slice(-GATHER_BLOCKED_WINDOW);
  const checkedAt = window[window.length - 1]?.at;
  if (
    window.length >= GATHER_BLOCKED_WINDOW &&
    window.every((row) => !row.srflx) &&
    stunProbesOk()
  ) {
    return { status: 'blocked', code: 'no_srflx', checkedAt };
  }
  return { status: 'unknown', checkedAt };
}

function peerRtcStatus(nodeId: string): Pick<MeshPortReach, 'status' | 'code' | 'checkedAt'> {
  const slot = state.dc.get(nodeId);
  if (!slot) return { status: 'unknown' };
  if (slot.up || state.now() - slot.lastUpAt <= DC_HISTORY_MS) {
    return { status: 'open', checkedAt: slot.lastUpAt };
  }
  return { status: 'unknown', checkedAt: slot.lastUpAt };
}

function shouldSkipCadence(
  force: boolean | undefined,
  lastAt: number,
  at: number,
  nodeId: string
): boolean {
  if (force) return false;
  if (state.forceProbe.delete(nodeId)) return false;
  return lastAt > 0 && at - lastAt < PORT_PROBE_CADENCE_MS;
}

export function bumpSelfPeerReachEpoch(): number {
  state.selfEpoch += 1;
  state.onSelfEpochBump?.();
  return state.selfEpoch;
}

export function peerReachEpochPayload(): number | undefined {
  return state.selfEpoch > 0 ? state.selfEpoch : undefined;
}

/** 对端 status 里的世代变大：清掉对该节点的 5 分钟节拍，下一轮 tick 立即重探。 */
export function ingestPeerReachEpoch(nodeId: string, epoch: unknown): void {
  const next = normalizePeerReachEpoch(epoch);
  if (next === undefined) return;
  const prev = state.seenEpochs.get(nodeId) ?? 0;
  if (next <= prev) return;
  state.seenEpochs.set(nodeId, next);
  state.forceProbe.add(nodeId);
  const slot = state.probes.get(nodeId);
  if (slot) slot.lastAt = 0;
}

export function setSelfPortRolesForTest(roles: SelfPortRoles | null): void {
  state.roles = roles;
}

export function notePublicHttpsUplink(uplinked: boolean): void {
  state.httpsUplink = uplinked;
}

function selfPeerSignaling(): Pick<MeshPortReach, 'status' | 'code' | 'checkedAt'> {
  if (state.peerServerListening === false) {
    return { status: 'blocked', code: 'peer_refused' };
  }
  // 成员报告只在有效期内计数：对端已移除或网络恢复后，旧的 refused/timeout 不能一直把本机判成 blocked
  const freshAfter = state.now() - PEER_REPORT_TTL_MS;
  const reports = [...state.reports.values()].filter((row) => row.at >= freshAfter);
  const checkedAt = reports.reduce((max, row) => Math.max(max, row.at), 0) || undefined;
  if (reports.some((row) => row.verdict === 'ok')) return { status: 'open', checkedAt };
  const refused = reports.filter((row) => row.verdict === 'refused');
  if (refused.length >= 1) {
    return { status: 'blocked', code: 'peer_refused', checkedAt };
  }
  const timeouts = reports.filter((row) => row.verdict === 'timeout');
  if (timeouts.some((row) => row.timeoutStrikes >= 2) || timeouts.length >= 2) {
    return { status: 'blocked', code: 'peer_timeout', checkedAt };
  }
  return { status: 'unknown', checkedAt };
}

function peerWsRefused(failure: MeshNodeDirectFailure | null | undefined): boolean {
  return failure?.wsCode === 'refused';
}

function peerSignalingOf(
  nodeId: string,
  failure: MeshNodeDirectFailure | null | undefined,
  hasPublicEndpoint: boolean
): Pick<MeshPortReach, 'status' | 'code' | 'checkedAt'> {
  if (!hasPublicEndpoint) return { status: 'unknown' };
  const slot = state.probes.get(nodeId);
  if (slot?.lastVerdict === 'ok') return { status: 'open', checkedAt: slot.checkedAt };
  if (slot?.status === 'blocked') {
    return { status: 'blocked', code: slot.code, checkedAt: slot.checkedAt };
  }
  if (peerWsRefused(failure)) {
    return { status: 'blocked', code: 'peer_refused', checkedAt: failure?.at };
  }
  if (slot) return { status: slot.status, code: slot.code, checkedAt: slot.checkedAt };
  return { status: 'unknown' };
}

function rtcRange(): PortRange {
  const live = gatewayConfig.rtcPortRange;
  return live ? { begin: live.begin, end: live.end } : { ...DEFAULT_RTC_PORT_RANGE };
}

function peerPortOf(endpoints: readonly string[]): number {
  for (const url of endpoints) {
    const target = probeTargetOf(url);
    if (target) return target.port;
    try {
      const parsed = new URL(url);
      if (parsed.port) return Number(parsed.port);
    } catch {
      /* skip */
    }
  }
  return gatewayConfig.peerPort || DEFAULT_PEER_PORT;
}

export function meshPortsForNode(input: {
  nodeId: string;
  selfId: string;
  endpoints?: readonly string[];
  directFailure?: MeshNodeDirectFailure | null;
  othersOnline?: boolean;
}): MeshPortReach[] {
  const isSelf = input.nodeId === input.selfId;
  const endpoints = input.endpoints ?? [];
  const peerPort = isSelf ? gatewayConfig.peerPort || DEFAULT_PEER_PORT : peerPortOf(endpoints);
  const hasPublic = isSelf || firstProbeableTarget(endpoints) != null;
  const signaling = isSelf
    ? selfPeerSignaling()
    : peerSignalingOf(input.nodeId, input.directFailure, hasPublic);
  const rtc = isSelf ? selfRtcStatus() : peerRtcStatus(input.nodeId);
  const rows: MeshPortReach[] = [
    {
      purpose: 'peer-signaling',
      proto: 'tcp',
      port: peerPort,
      status: signaling.status,
      ...(signaling.code ? { code: signaling.code } : {}),
      ...(signaling.checkedAt ? { checkedAt: signaling.checkedAt } : {}),
    },
    {
      purpose: 'rtc-ice',
      proto: 'udp',
      range: rtcRange(),
      status: rtc.status,
      ...(rtc.code ? { code: rtc.code } : {}),
      ...(rtc.checkedAt ? { checkedAt: rtc.checkedAt } : {}),
    },
  ];
  if (isSelf) rows.push(...selfDerivedRows(input.othersOnline === true));
  return rows;
}

function selfDerivedRows(othersOnline: boolean): MeshPortReach[] {
  const roles = state.roles ?? {
    hub: gatewayConfig.roles.hub,
    relay: gatewayConfig.roles.relay,
  };
  const httpsUplink = state.httpsUplink || othersOnline || hasFreshPeerReports();
  const turnKey = localRelaySnapshotKey();
  return derivedSelfPortRows({
    roles,
    httpsUplink,
    turn: membersProbeSnapshot(turnKey),
  });
}

function hasFreshPeerReports(): boolean {
  const freshAfter = state.now() - PEER_REPORT_TTL_MS;
  for (const row of state.reports.values()) {
    if (row.at >= freshAfter) return true;
  }
  return false;
}

export function overlayMeshNodePorts(nodes: MeshNodeDto[], selfId: string): MeshNodeDto[] {
  const othersOnline = nodes.some((node) => node.id !== selfId && node.online);
  return nodes.map((node) => ({
    ...node,
    ports: meshPortsForNode({
      nodeId: node.id,
      selfId,
      endpoints: node.endpoints,
      directFailure: node.directFailure,
      othersOnline,
    }),
  }));
}

function endpointsFromPeer(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

export function bootPortReach(input: {
  startPeerServer?: boolean;
  listenPort: number | null;
  selfNodeId: string;
  userStore: UserStore;
  pathRttMemory?: PeerPathRttMemory;
  now?: () => number;
  previous?: (() => void) | null;
  onSelfEpochBump?: () => void;
}): () => void {
  input.previous?.();
  state.onSelfEpochBump = input.onSelfEpochBump ?? null;
  if (input.startPeerServer !== false) notePeerServerBind(input.listenPort != null);
  return attachPortReachToMesh(input);
}

export function attachPortReachToMesh(input: {
  selfNodeId: string;
  userStore: UserStore;
  /** 每次 TCP connect 成功都作为一条 `tcp-connect` 路径样本写进来；DC 重掷判定的 best 之一。 */
  pathRttMemory?: PeerPathRttMemory;
  now?: () => number;
}): () => void {
  if (input.now) {
    state.now = input.now;
    setTurnReachNow(input.now);
  }
  const tick = () => {
    for (const peer of input.userStore.listPeers()) {
      if (peer.nodeId === input.selfNodeId) continue;
      void probePeerEndpoints(peer.nodeId, endpointsFromPeer(peer.endpointsJson), {
        pathRttMemory: input.pathRttMemory,
      });
    }
  };
  const timer = setInterval(tick, PORT_PROBE_TICK_MS);
  timer.unref?.();
  tick();
  return () => clearInterval(timer);
}
