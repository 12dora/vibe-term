import type { LinkSession } from '@tmex/shared/link';
import type { UserStore } from '../auth/user-store';
import type { DirectAttemptRecord } from './peer-direct-attempt';
import type { PeerEndpointBackoff } from './peer-endpoint-backoff';
import type { LiveWaiter, ParkedInbound, TransportWaiter } from './peer-manager-types';
import { type LivePeer, PeerReconnectWake } from './peer-reconnect-wake';
import type { RtcSignalInboxEntry } from './peer-rtc-wake';
import {
  type MeshIdentity,
  type MeshScheduler,
  NodeUnreachableError,
  type PeerTransportKind,
} from './types';
import type { UplinkClient } from './uplink-client';
import type { UplinkPool } from './uplink-pool';

export const PEER_IDLE_MS = 5 * 60 * 1000;
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
  readonly uplink: UplinkClient | UplinkPool;
  readonly scheduler: MeshScheduler;
  readonly live: Map<string, LivePeer>;
  readonly parked: Map<string, ParkedInbound>;
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
};

export function createPeerManagerState(opts: {
  identity: MeshIdentity;
  userStore: UserStore;
  uplink: UplinkClient | UplinkPool;
  scheduler: MeshScheduler;
  endpointBackoff: PeerEndpointBackoff;
}): PeerManagerState {
  return {
    stopped: false,
    generation: 0,
    stopAbort: new AbortController(),
    identity: opts.identity,
    userStore: opts.userStore,
    uplink: opts.uplink,
    scheduler: opts.scheduler,
    live: new Map(),
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
  };
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
