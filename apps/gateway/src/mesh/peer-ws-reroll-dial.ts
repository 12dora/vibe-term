import type { LinkSession, WebSocketTransportInput } from '@vibeterm/shared/link';
import {
  type RankableIfaceAddr,
  dropFakeIpv4PeerEndpoints,
  hostFromWsUrl,
  rankPeerEndpoints,
} from './address-class';
import { debugLine } from './mesh-log';
import { parseEndpoints } from './peer-dc-upgrade';
import { raceWsSecureDial } from './peer-dial-race';
import {
  type DirectAttemptRecord,
  eligiblePeerEndpoints,
  noteNoEndpoints,
  noteWsRaceFailure,
} from './peer-direct-attempt';
import { dedupeRankedPeerEndpoints } from './peer-endpoint-backoff';
import {
  PEER_LAN_DIAL_TIMEOUT_MS,
  PEER_WS_DIAL_STAGGER_MS,
  type PeerManagerState,
  peerStale,
  throwIfPeerStopped,
} from './peer-manager-state';
import type { PeerLinkFactory } from './peer-manager-types';
import { type DirectDialLimiter, abortable, quiet } from './peer-ws-race';
import { NodeUnreachableError, type PeerTransportKind } from './types';

export type PeerDialInflightMode = 'foreground' | 'background';

/**
 * 同一对端的拨号槽：前台复用已在途的 Promise，后台（含 ws 重赛）遇到在途则放弃。
 * 与 `dcInflight` 同一套语义，避免两条 ws 同时 track 把重赛 park 掉。
 */
export function sharePeerDialInflight<T>(
  map: Map<string, Promise<T | null>>,
  nodeId: string,
  mode: PeerDialInflightMode,
  run: () => Promise<T | null>
): Promise<T | null> {
  const existing = map.get(nodeId);
  if (existing) return mode === 'foreground' ? existing : Promise.resolve(null);
  // 首个与复用方拿到同一个 Promise：失败照样 reject 给每个调用方自己归因，不能吞成 null。
  const work = run();
  map.set(nodeId, work);
  work.then(
    () => {
      if (map.get(nodeId) === work) map.delete(nodeId);
    },
    () => {
      if (map.get(nodeId) === work) map.delete(nodeId);
    }
  );
  return work;
}

/** live 已不是要换掉的那条：关重赛 session，不二次记预算。 */
export function dropStaleWsReroll(
  state: PeerManagerState,
  nodeId: string,
  session: LinkSession,
  expectedLive: LinkSession | null | undefined
): boolean {
  if (state.live.get(nodeId)?.session === expectedLive) return false;
  quiet(() => session.close('reroll-stale'));
  debugLine('[mesh][rtc]', `reroll_stale peer=${nodeId.slice(0, 8)} transport=ws-secure`);
  return true;
}

export type WsSecureDialOpts = {
  bypassBackoff?: boolean;
  endpoints?: string[];
  mode?: 'foreground' | 'reroll';
  expectedLive?: LinkSession | null;
};

export type WsSecureDialHost = {
  state: PeerManagerState;
  linkFactory: PeerLinkFactory | null;
  wsFactory: (url: string) => WebSocketTransportInput | Promise<WebSocketTransportInput>;
  connectTimeoutMs: number;
  dialLimiter: DirectDialLimiter;
  interfacesFn: () => Record<string, RankableIfaceAddr[] | undefined>;
  listenPort: () => number | undefined;
  rememberKeys: (session: LinkSession, sendKey?: Uint8Array, recvKey?: Uint8Array) => void;
  track: (
    session: LinkSession,
    peerNodeId: string,
    transport: PeerTransportKind,
    initiatedBy: string,
    gen: number,
    quiesceCapable?: boolean,
    remoteAddress?: string | null,
    dcAttemptId?: string | null,
    rtcEpoch?: number
  ) => LinkSession | null;
};

function keepWs(
  host: WsSecureDialHost,
  session: LinkSession,
  nodeId: string,
  gen: number,
  remoteAddress: string | null,
  opts?: WsSecureDialOpts
): LinkSession | null {
  if (
    opts?.mode === 'reroll' &&
    dropStaleWsReroll(host.state, nodeId, session, opts.expectedLive)
  ) {
    return null;
  }
  return host.track(
    session,
    nodeId,
    'ws-secure',
    host.state.identity.nodeId,
    gen,
    false,
    remoteAddress
  );
}

export async function connectWsSecure(
  host: WsSecureDialHost,
  nodeId: string,
  gen: number,
  signal: AbortSignal,
  attempt: DirectAttemptRecord,
  opts?: WsSecureDialOpts
): Promise<LinkSession | null> {
  const { state } = host;
  if (host.linkFactory && !opts?.endpoints) {
    try {
      const session = await abortable(Promise.resolve(host.linkFactory(nodeId, signal)), signal);
      if (session) {
        if (peerStale(state, gen)) {
          quiet(() => session.close('stopped'));
          throw new NodeUnreachableError(nodeId, 'peer manager stopped');
        }
        const kept = keepWs(host, session, nodeId, gen, null, opts);
        if (kept) return kept;
      }
    } catch (err) {
      throwIfPeerStopped(state, nodeId, gen, err);
    }
  }
  const cached = state.userStore.getPeer(nodeId);
  const parsed = dropFakeIpv4PeerEndpoints(
    opts?.endpoints ?? (cached ? parseEndpoints(cached.endpointsJson, host.listenPort()) : []),
    nodeId
  );
  const endpoints = dedupeRankedPeerEndpoints(rankPeerEndpoints(parsed, host.interfacesFn()));
  if (endpoints.length === 0) {
    noteNoEndpoints(attempt);
    return null;
  }
  const eligible = eligiblePeerEndpoints(
    state.endpointBackoff,
    nodeId,
    endpoints,
    attempt,
    state.scheduler.now(),
    opts?.bypassBackoff
  );
  if (eligible.length === 0) return null;
  const raced = await raceWsSecureDial({
    nodeId,
    gen,
    urls: eligible,
    signal,
    staggerMs: PEER_WS_DIAL_STAGGER_MS,
    connectTimeoutMs: host.connectTimeoutMs,
    lanTimeoutMs: PEER_LAN_DIAL_TIMEOUT_MS,
    identity: state.identity,
    userStore: state.userStore,
    limiter: host.dialLimiter,
    backoff: state.endpointBackoff,
    wsFactory: host.wsFactory,
    stale: (g) => peerStale(state, g),
    sleep: (ms, sig) => state.scheduler.sleep(ms, sig),
  });
  noteWsRaceFailure(attempt, raced, endpoints);
  if (peerStale(state, gen)) {
    quiet(() => raced.winner?.session.close('stopped'));
    throwIfPeerStopped(state, nodeId, gen);
  }
  const winner = raced.winner;
  if (!winner) return null;
  host.rememberKeys(winner.session, winner.sendKey, winner.recvKey);
  return keepWs(host, winner.session, winner.peerNodeId, gen, hostFromWsUrl(winner.url), opts);
}
