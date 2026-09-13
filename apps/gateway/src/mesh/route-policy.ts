import type { MeshPathKind, MeshRouteMode, MeshStreamClass } from '@vibeterm/shared/net';
import type { PeerPathRttMemory } from './peer-path-rtt';
import type { RelayPresenceIndex } from './relay-presence-types';
import type { PeerTransportKind } from './types';

/** 连续 N 次 live ping 都慢才直连→中继；5 s 心跳下标称 ≥ 15 s。 */
export const ROUTE_DEGRADE_CONSECUTIVE = 3;
export const ROUTE_DEGRADE_MIN_SPAN_MS = 15_000;
export const ROUTE_DEGRADE_MULTIPLIER = 1.5;
export const ROUTE_DEGRADE_ADDITIVE_MS = 40;

/** 升回直连：≥ 3 个 ping，且 RTT < relayMs − max(5 ms, 20% × relayMs)；加法项要小于常见中继 RTT（~15 ms），否则局域网直连永远升不回。 */
export const ROUTE_PROMOTE_SAMPLES = 3;
export const ROUTE_PROMOTE_ADDITIVE_MS = 5;
export const ROUTE_PROMOTE_RATIO = 0.2;

/** 降级后禁止再拨直连：起步 2 min，翻倍封顶 30 min。 */
export const ROUTE_PROMOTE_BACKOFF_START_MS = 2 * 60 * 1000;
export const ROUTE_PROMOTE_BACKOFF_CAP_MS = 30 * 60 * 1000;

/**
 * 预留给 bulk 双 live：中继必须同时好出绝对量与相对量，bulk 才离开直连。
 * 本轮每对端只有一条 live，interactive / bulk 都跟这条 live。
 */
export const ROUTE_BULK_RELAY_GAIN_MS = 40;
export const ROUTE_BULK_RELAY_GAIN_RATIO = 0.2;

const DIRECT_KINDS = ['dc', 'ws-secure'] as const;

export function isDirectTransport(transport: string): transport is 'dc' | 'ws-secure' {
  return transport === 'dc' || transport === 'ws-secure';
}

export function pathKindOf(transport: PeerTransportKind): MeshPathKind {
  return isDirectTransport(transport) ? 'direct' : 'relay';
}

export function finiteRttMs(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function directSlowThresholdMs(relayMs: number): number {
  return Math.max(ROUTE_DEGRADE_MULTIPLIER * relayMs, relayMs + ROUTE_DEGRADE_ADDITIVE_MS);
}

export function isDirectSlowVsRelay(directMs: number, relayMs: number): boolean {
  return directMs > directSlowThresholdMs(relayMs);
}

export function promoteMarginMs(relayMs: number): number {
  return Math.max(ROUTE_PROMOTE_ADDITIVE_MS, ROUTE_PROMOTE_RATIO * relayMs);
}

/** 直连必须比中继好出 max(5 ms, 20%)，否则保持中继。 */
export function shouldPromoteDirect(directMs: number, relayMs: number): boolean {
  return directMs < relayMs - promoteMarginMs(relayMs);
}

export function nextPromoteBackoffMs(prevMs: number | null | undefined): number {
  if (prevMs == null || prevMs <= 0) return ROUTE_PROMOTE_BACKOFF_START_MS;
  return Math.min(prevMs * 2, ROUTE_PROMOTE_BACKOFF_CAP_MS);
}

/** bulk 预留：中继同时好出 40 ms 与 20% 才认为值得离开直连。 */
export function relayClearlyBetterForBulk(directMs: number, relayMs: number): boolean {
  if (directMs <= relayMs) return false;
  const gain = directMs - relayMs;
  return gain > ROUTE_BULK_RELAY_GAIN_MS && gain > directMs * ROUTE_BULK_RELAY_GAIN_RATIO;
}

export type RoutePolicySnapshot = {
  mode: MeshRouteMode;
  streamClass: MeshStreamClass;
  liveKind: MeshPathKind | null;
  directMs: number | null;
  relayMs: number | null;
  degraded: boolean;
  backoffActive: boolean;
};

function autoPathWhenDirectLive(snap: RoutePolicySnapshot): MeshPathKind {
  if (snap.directMs == null || snap.relayMs == null) return 'direct';
  return isDirectSlowVsRelay(snap.directMs, snap.relayMs) ? 'relay' : 'direct';
}

function autoPathWhenRelayLive(
  streamClass: MeshStreamClass,
  snap: RoutePolicySnapshot
): MeshPathKind {
  if (streamClass !== 'bulk' || snap.directMs == null || snap.relayMs == null) return 'relay';
  return relayClearlyBetterForBulk(snap.directMs, snap.relayMs) ? 'relay' : 'direct';
}

function autoPathWhenNoLive(streamClass: MeshStreamClass, snap: RoutePolicySnapshot): MeshPathKind {
  if (streamClass !== 'bulk' || snap.directMs == null || snap.relayMs == null) return 'direct';
  return relayClearlyBetterForBulk(snap.directMs, snap.relayMs) ? 'relay' : 'direct';
}

/**
 * 选路决策。本轮 mesh 每对端一条 live，`getLink` 不按 streamClass 分叉；
 * bulk 分支只编码「双 live 时 bulk 更粘直连」的门槛，方便后续接。
 */
export function decidePath(
  peerId: string,
  streamClass: MeshStreamClass,
  snap: RoutePolicySnapshot
): MeshPathKind {
  void peerId;
  if (snap.mode === 'relay') return 'relay';
  if (snap.mode === 'direct') return 'direct';
  if (snap.backoffActive || snap.degraded) return 'relay';
  if (snap.liveKind === 'direct') return autoPathWhenDirectLive(snap);
  if (snap.liveKind === 'relay') return autoPathWhenRelayLive(streamClass, snap);
  return autoPathWhenNoLive(streamClass, snap);
}

export function readDirectMs(input: {
  liveTransport: string | null | undefined;
  liveRttMs: number | null | undefined;
  peerId: string;
  pathRtt: Pick<PeerPathRttMemory, 'bestMs'>;
}): number | null {
  if (input.liveTransport && isDirectTransport(input.liveTransport)) {
    return finiteRttMs(input.liveRttMs);
  }
  return finiteRttMs(input.pathRtt.bestMs(input.peerId, DIRECT_KINDS));
}

export function estimateRelayMs(input: {
  liveIsRelay: boolean;
  liveRttMs: number | null | undefined;
  selfUplinkMs: number | null;
  peerUplinkMs: number | null;
  chooseScoreMs: number | null;
}): number | null {
  if (input.liveIsRelay) {
    const live = finiteRttMs(input.liveRttMs);
    if (live != null) return live;
  }
  const score = finiteRttMs(input.chooseScoreMs);
  if (score != null) return score;
  const self = finiteRttMs(input.selfUplinkMs);
  if (self == null) return null;
  const peer = finiteRttMs(input.peerUplinkMs);
  return peer != null ? self + peer : 2 * self;
}

export function peerUplinkMsFromPresence(
  presence: RelayPresenceIndex | undefined,
  peerId: string
): { chooseScoreMs: number | null; peerUplinkMs: number | null } {
  if (!presence) return { chooseScoreMs: null, peerUplinkMs: null };
  const choice = presence.chooseRelay(peerId);
  const chooseScoreMs = finiteRttMs(choice?.scoreMs);
  let peerUplinkMs: number | null = null;
  for (const row of presence.snapshot()) {
    const peer = row.peers.get(peerId);
    const rtt = finiteRttMs(peer?.rttMs);
    if (rtt == null) continue;
    peerUplinkMs = peerUplinkMs == null ? rtt : Math.min(peerUplinkMs, rtt);
  }
  return { chooseScoreMs, peerUplinkMs };
}

export function relayMsForPeer(input: {
  liveTransport: string | null | undefined;
  liveRttMs: number | null | undefined;
  peerId: string;
  selfUplinkMs: number | null;
  presence?: RelayPresenceIndex;
}): number | null {
  const fromPresence = peerUplinkMsFromPresence(input.presence, input.peerId);
  return estimateRelayMs({
    liveIsRelay: input.liveTransport === 'relay',
    liveRttMs: input.liveRttMs,
    selfUplinkMs: input.selfUplinkMs,
    peerUplinkMs: fromPresence.peerUplinkMs,
    chooseScoreMs: fromPresence.chooseScoreMs,
  });
}
