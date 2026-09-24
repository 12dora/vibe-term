import type { LinkSession } from '@vibeterm/shared/link';
import { DEFAULT_DIAL_RTT_MS, nestedDialBudgetsMs } from '@vibeterm/shared/net';
import type { UserStore } from '../auth/user-store';
import type { DcRerollRecord } from './peer-dc-reroll';
import type { DirectAttemptRecord } from './peer-direct-attempt';
import type { PeerEndpointBackoff } from './peer-endpoint-backoff';
import type { LiveWaiter, ParkedInbound, TransportWaiter } from './peer-manager-types';
import { PEER_PATH_RTT_WINDOW_MS, PeerPathRttMemory } from './peer-path-rtt';
import { type LivePeer, PeerReconnectWake } from './peer-reconnect-wake';
import type { RtcSignalInboxEntry } from './peer-rtc-wake';
import type { RelayPresenceIndex, RelayStreamOpener } from './relay-presence-types';
import {
  type MeshIdentity,
  type MeshScheduler,
  NodeUnreachableError,
  type PeerTransportKind,
  type PooledUplink,
} from './types';
import type { UplinkPool } from './uplink-pool';

export const PEER_IDLE_MS = 5 * 60 * 1000;
/** DataChannel 建连成本高，空闲拆链给 30 min；relay / ws-secure 仍用 PEER_IDLE_MS。 */
export const PEER_DC_IDLE_MS = 30 * 60 * 1000;
export const PEER_RTT_EWMA_ALPHA = 0.3;
export const PEER_RTT_SPIKE_MULT = 3;
export const PEER_CONNECT_TIMEOUT_MS = 3_000;
export const PEER_LAN_DIAL_TIMEOUT_MS = 4_000;
export const PEER_WS_DIAL_STAGGER_MS = 250;
export const PEER_PING_INTERVAL_MS = 5_000;
export const PEER_MISSED_PONG_LIMIT = 3;
export const PEER_MAX_CONCURRENT_STREAMS = 256;
export const KEY_LOG_STATUS_DEBOUNCE_MS = 100;
export const PEER_RETIRE_MIN_MS = 5_000;
export const PEER_RETIRE_QUIET_MS = 2_000;
export const PEER_RETIRE_MAX_MS = 30_000;
/** 退役 session 仍有内层流时的泄漏上限：到期后以 `retired` 强制关闭。 */
export const PEER_RETIRE_STREAM_LEAK_MS = 30 * 60 * 1000;
/**
 * 原生 SCTP 与 liveness 都在建连后约 10s 掐掉还没稳住的 DC。
 * 证明之外再活过这段才允许拆中继；仍受 PEER_RETIRE_MAX_MS（30s）封顶。
 */
export const DC_MIN_STABLE_MS = 15_000;
/** 旧实现按次数封顶；现在每次短命夭折都升级冷却，这两个常量不再参与计算。 */
export const DC_UNSTABLE_STRIKES = 3;
export const DC_UNSTABLE_WINDOW_MS = 3 * 60 * 1000;
/** 短命 DC 的第一档冷却。之后翻倍，不抬拨号熔断的 level / consecutiveFailures。 */
export const DC_UNSTABLE_BACKOFF_MS = 60_000;
export const DC_UNSTABLE_BACKOFF_CAP_MS = 30 * 60 * 1000;
export const RTC_PEER_INBOX_MAX_MESSAGES = 32;

export const PEER_TRANSPORT_RANK: Record<PeerTransportKind, number> = {
  dc: 3,
  'ws-secure': 2,
  relay: 1,
};

export function comparePeerTransport(a: PeerTransportKind, b: PeerTransportKind): number {
  return PEER_TRANSPORT_RANK[a] - PEER_TRANSPORT_RANK[b];
}

export type PeerSessionKeys = { sendKey: Uint8Array; recvKey: Uint8Array };

/** 被多个协作者共享的可变状态，由 PeerManager 构造一次后传给各协作者。 */
export type PeerManagerState = {
  stopped: boolean;
  generation: number;
  stopAbort: AbortController;
  readonly identity: MeshIdentity;
  readonly userStore: UserStore;
  readonly uplink: (PooledUplink & { resetBackoff(): void }) | UplinkPool;
  readonly scheduler: MeshScheduler;
  readonly live: Map<string, LivePeer>;
  readonly parked: Map<string, ParkedInbound>;
  /** 多中继同时挂载时由 relay wiring 注入；单中继时为 undefined。 */
  relayPresence?: RelayPresenceIndex;
  relayOpener?: RelayStreamOpener;
  readonly retiring: Map<string, Set<LivePeer>>;
  readonly pending: Map<string, Promise<LinkSession>>;
  readonly upgrading: Map<string, Promise<LinkSession>>;
  readonly liveWaiters: Map<string, LiveWaiter[]>;
  readonly transportWaiters: Map<string, TransportWaiter[]>;
  readonly sessionKeys: WeakMap<LinkSession, PeerSessionKeys>;
  readonly rtcInbox: Map<string, RtcSignalInboxEntry[]>;
  readonly lostDirect: Set<string>;
  readonly lastDirectAttempt: Map<string, DirectAttemptRecord>;
  readonly advertisedEndpointSet: Map<string, string>;
  readonly endpointBackoff: PeerEndpointBackoff;
  readonly peerReconnectWake: PeerReconnectWake;
  readonly pathRtt: PeerPathRttMemory;
  readonly rerolls: Map<string, DcRerollRecord>;
  /** 对端 pending-measure 隔离的截止时间（Date.now()）。退役判断用它留住中继。 */
  readonly remoteMeasureUntil: Map<string, number>;
  /** 测量期间为用户流量旁路拨出的中继，不替换 live DC。 */
  readonly sideRelays: Map<string, LinkSession>;
  /** 这一跳 forceInstall 应旁路停放，而不是把 live DC 退役掉。 */
  readonly besideRelayDial: Set<string>;
  /** 旁路中继入站分发。不把它装成 live。 */
  sideRelayAttach?: (session: LinkSession, peerId: string) => void;
};

const rttByScheduler = new WeakMap<object, PeerManagerState>();

function finiteRtt(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function resolveRttState(scheduler?: object): PeerManagerState | undefined {
  return scheduler ? rttByScheduler.get(scheduler) : undefined;
}

function trackedSessionOf(state: PeerManagerState, link: LinkSession): LivePeer | undefined {
  for (const live of state.live.values()) {
    if (live.session === link) return live;
  }
  for (const group of state.retiring.values()) {
    for (const live of group) {
      if (live.session === link) return live;
    }
  }
  return undefined;
}

/** @deprecated RTT 源只挂在 scheduler WeakMap 上，不再有进程级单例。 */
export function resetPeerRttLookupForTests(): void {}

export type PeerRttSampleTarget = {
  rttMs: number | null;
  rttSpikeIgnored?: boolean;
};

/** ping.sentAt 是发送端 monotonic 不透明值；非有限数字一律忽略。 */
export function parseEchoedSentAt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 只有发出 ping 的那一端用同一把 monotonic 时钟算 RTT。
 * 回显必须 ≤ now；未来值 / 非有限值退回本地 pingSentAt，再不行丢弃。
 */
export function measurePingRttMs(
  now: number,
  echoedSentAt: number | undefined,
  localSentAt: number | null | undefined
): number | null {
  const echoed =
    echoedSentAt != null && Number.isFinite(echoedSentAt) && echoedSentAt <= now
      ? echoedSentAt
      : undefined;
  const local = localSentAt != null && Number.isFinite(localSentAt) ? localSentAt : undefined;
  const sentAt = echoed ?? local;
  if (sentAt == null || !Number.isFinite(now) || sentAt > now) return null;
  return now - sentAt;
}

/** 一次样本：α=0.3 EWMA；超过当前 EWMA 3 倍的尖峰忽略一次。 */
export function applyPeerRttSample(live: PeerRttSampleTarget, sampleMs: number): number {
  const sample = Math.max(0, Math.round(sampleMs));
  if (live.rttMs == null) {
    live.rttMs = sample;
    live.rttSpikeIgnored = false;
    return sample;
  }
  if (sample > PEER_RTT_SPIKE_MULT * live.rttMs && !live.rttSpikeIgnored) {
    live.rttSpikeIgnored = true;
    return live.rttMs;
  }
  live.rttSpikeIgnored = false;
  live.rttMs = Math.round(PEER_RTT_EWMA_ALPHA * sample + (1 - PEER_RTT_EWMA_ALPHA) * live.rttMs);
  return live.rttMs;
}

function medianRtt(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
  }
  return sorted[mid] ?? 0;
}

export function readUplinkRtt(uplink: PooledUplink | UplinkPool): number | null {
  const pooled = uplink as UplinkPool;
  if (typeof pooled.candidates === 'function') {
    let best: number | null = null;
    try {
      for (const row of pooled.candidates()) {
        const rtt = finiteRtt(row.rttMs);
        if (rtt == null) continue;
        best = best == null ? rtt : Math.min(best, rtt);
      }
    } catch {
      // 池还没就绪
    }
    if (best != null) return best;
  }
  return finiteRtt((uplink as { rttMs?: number | null }).rttMs);
}

function liveMedianRtt(state: PeerManagerState): number | null {
  const samples: number[] = [];
  for (const live of state.live.values()) {
    const rtt = finiteRtt(live.rttMs);
    if (rtt != null) samples.push(rtt);
  }
  return samples.length > 0 ? medianRtt(samples) : null;
}

/** 无本链路样本时的转发兜底：max(全网中位数, uplinkRtt) → 800 ms。不要用 pathRtt.bestMs。 */
function pessimisticForwardRttMs(state: PeerManagerState): number {
  const median = liveMedianRtt(state);
  const uplink = readUplinkRtt(state.uplink);
  if (median != null && uplink != null) return Math.max(median, uplink);
  return median ?? uplink ?? DEFAULT_DIAL_RTT_MS;
}

/** 已测节点 RTT → 全网 live 中位数 → uplink 代理 → 800 ms。拨号用；无 nodeId 时不用全局 max。 */
export function lookupPeerRttMs(nodeId?: string, scheduler?: object): number {
  const state = resolveRttState(scheduler);
  if (!state) return DEFAULT_DIAL_RTT_MS;
  if (nodeId) {
    const peer = finiteRtt(state.live.get(nodeId)?.rttMs);
    if (peer != null) return peer;
  }
  return liveMedianRtt(state) ?? readUplinkRtt(state.uplink) ?? DEFAULT_DIAL_RTT_MS;
}

/**
 * 转发 / head 预算：本链路样本 → max(中位数, uplinkRtt) → 800 ms。
 * 新建链路 rttMs 为 null 时必须走悲观兜底，不能用乐观中位数。
 */
export function lookupPeerRttMsForForward(nodeId: string | undefined, scheduler?: object): number {
  const state = resolveRttState(scheduler);
  if (!state) return DEFAULT_DIAL_RTT_MS;
  if (nodeId) {
    const sample = finiteRtt(state.live.get(nodeId)?.rttMs);
    if (sample != null) return sample;
  }
  return pessimisticForwardRttMs(state);
}

/** 用 live/retiring session 反查该链路 RTT。无本链路样本时悲观，不回落乐观中位数。 */
export function lookupPeerRttMsForLink(link: LinkSession, scheduler?: object): number {
  const state = resolveRttState(scheduler);
  if (!state) return DEFAULT_DIAL_RTT_MS;
  const tracked = trackedSessionOf(state, link);
  const sample = finiteRtt(tracked?.rttMs);
  if (sample != null) return sample;
  return pessimisticForwardRttMs(state);
}

/** missed-pong 判死窗口：至少 15 s，且严格大于同档 head 预算。 */
export function peerLivenessDeadlineMs(rttMs: number | null | undefined): number {
  const headMs = nestedDialBudgetsMs(rttMs).forwardMs;
  const floorMs = PEER_PING_INTERVAL_MS * PEER_MISSED_PONG_LIMIT;
  return Math.max(floorMs, headMs + PEER_PING_INTERVAL_MS);
}

export function missedPongExceeded(missedPongs: number, rttMs: number | null | undefined): boolean {
  return missedPongs * PEER_PING_INTERVAL_MS >= peerLivenessDeadlineMs(rttMs);
}

export function createPeerManagerState(opts: {
  identity: MeshIdentity;
  userStore: UserStore;
  uplink: (PooledUplink & { resetBackoff(): void }) | UplinkPool;
  scheduler: MeshScheduler;
  endpointBackoff: PeerEndpointBackoff;
}): PeerManagerState {
  const live = new Map<string, LivePeer>();
  opts.endpointBackoff.bindRttSource({
    peerRtt: (nodeId) => finiteRtt(live.get(nodeId)?.rttMs),
    uplinkRtt: () => readUplinkRtt(opts.uplink),
  });
  const state: PeerManagerState = {
    stopped: false,
    generation: 0,
    stopAbort: new AbortController(),
    identity: opts.identity,
    userStore: opts.userStore,
    uplink: opts.uplink,
    scheduler: opts.scheduler,
    live,
    parked: new Map(),
    retiring: new Map(),
    pending: new Map(),
    upgrading: new Map(),
    liveWaiters: new Map(),
    transportWaiters: new Map(),
    sessionKeys: new WeakMap(),
    rtcInbox: new Map(),
    lostDirect: new Set(),
    lastDirectAttempt: new Map(),
    advertisedEndpointSet: new Map(),
    endpointBackoff: opts.endpointBackoff,
    peerReconnectWake: new PeerReconnectWake(),
    pathRtt: new PeerPathRttMemory({
      now: () => opts.scheduler.now(),
      ttlMs: PEER_PATH_RTT_WINDOW_MS,
    }),
    rerolls: new Map(),
    remoteMeasureUntil: new Map(),
    sideRelays: new Map(),
    besideRelayDial: new Set(),
  };
  rttByScheduler.set(opts.scheduler, state);
  return state;
}

export function peerStale(state: PeerManagerState, gen: number): boolean {
  return state.stopped || gen !== state.generation;
}

export function throwIfPeerStopped(
  state: PeerManagerState,
  nodeId: string,
  gen: number,
  err?: unknown
): void {
  if (!peerStale(state, gen)) return;
  throw err instanceof NodeUnreachableError
    ? err
    : new NodeUnreachableError(nodeId, 'peer manager stopped');
}

export function isPeerTrusted(state: PeerManagerState, nodeId: string): boolean {
  const cert = state.userStore.getCert(nodeId);
  if (!cert || cert.revokedLogSeq != null) return false;
  const uid = state.uplink.userId;
  return !!uid && cert.userId === uid;
}
