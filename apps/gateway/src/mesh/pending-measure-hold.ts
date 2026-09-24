import type { LinkSession, LinkStream } from '@vibeterm/shared/link';
import { encodeJsonBytes } from './ctl';
import { PEER_PING_INTERVAL_MS, comparePeerTransport } from './peer-manager-state';
import { parseOpenPayload } from './peer-protocol';
import type { LivePeer } from './peer-reconnect-wake';
import { quiet } from './peer-ws-race';
import { ROUTE_PROMOTE_SAMPLES, isDirectTransport } from './route-policy';
import type { PeerTransportKind } from './types';

/** 对端在测量完成前复位用户流。开流即拒，请求还没进对端业务。 */
export const PENDING_MEASURE_REASON = 'pending-measure';
/** 持有方测量通过、开始承载用户流。接收方据此解除隔离。 */
export const ROUTE_PROMOTED_CTL = 'route-promoted';

/**
 * 对端 3 次 ping 才提升。多留一个间隔，旧版本不发 route-promoted 时也不会在第三拍之前探回 DC。
 */
export const REMOTE_HOLD_MS = (ROUTE_PROMOTE_SAMPLES + 1) * PEER_PING_INTERVAL_MS;

type RefusalNotice = {
  nodeId: string;
  session: LinkSession | null;
  now: number;
};

type HoldState = {
  until: Map<string, number>;
  sessions: WeakMap<LinkSession, number>;
  watched: WeakSet<LinkSession>;
  unsub: (() => void) | null;
};

const listeners = new Set<(notice: RefusalNotice) => void>();
const states = new WeakMap<object, HoldState>();
const linkTransport = new WeakMap<LinkSession, PeerTransportKind>();

function holdState(coord: object): HoldState {
  let state = states.get(coord);
  if (!state) {
    state = { until: new Map(), sessions: new WeakMap(), watched: new WeakSet(), unsub: null };
    states.set(coord, state);
  }
  return state;
}

export function subscribeTransportRefused(listener: (notice: RefusalNotice) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 转发层看见 pending-measure 时同步通知路由层，不等 stream.closed 的微任务。 */
export function emitTransportRefused(
  nodeId: string,
  session: LinkSession | null,
  now = Date.now()
): void {
  const notice = { nodeId, session, now };
  for (const listener of listeners) quiet(() => listener(notice));
}

export function rememberLinkTransport(session: LinkSession, transport: PeerTransportKind): void {
  linkTransport.set(session, transport);
}

export function transportOfLink(session: LinkSession): PeerTransportKind | null {
  return linkTransport.get(session) ?? null;
}

export function attachRemoteHold(coord: object): void {
  const state = holdState(coord);
  state.unsub?.();
  state.unsub = subscribeTransportRefused((notice) => {
    extendHold(state, notice.nodeId, notice.session, notice.now);
  });
}

export function detachRemoteHold(coord: object): void {
  const state = states.get(coord);
  if (!state) return;
  state.unsub?.();
  states.delete(coord);
}

export function remoteDirectBlocked(coord: object, nodeId: string, now: number): boolean {
  const state = states.get(coord);
  if (!state) return false;
  return now < (state.until.get(nodeId) ?? 0);
}

export function signalRoutePromoted(session: LinkSession): void {
  quiet(() => session.ctl.send(encodeJsonBytes({ t: ROUTE_PROMOTED_CTL })));
}

export function armPendingMeasureWatch(coord: object, session: LinkSession, peerId: string): void {
  const state = holdState(coord);
  if (state.watched.has(session)) return;
  if (typeof session.openStream !== 'function') return;
  state.watched.add(session);
  wrapLocalOpen(state, session, peerId);
  watchPromotion(state, session, peerId);
}

export async function resolveRefusedUserLink(
  coord: object,
  live: LivePeer,
  opts: {
    now: number;
    retiring: Iterable<LivePeer> | undefined;
    dialRelay: () => Promise<LinkSession | null>;
  }
): Promise<LinkSession | null> {
  if (!isDirectTransport(live.transport)) return null;
  if (!directRefused(coord, live.peerNodeId, live.session, opts.now)) return null;
  const fallback = pickRetiringNonDc(opts.retiring, live.session);
  if (fallback) {
    rememberLinkTransport(fallback.session, fallback.transport);
    return fallback.session;
  }
  const relay = await opts.dialRelay();
  if (relay) rememberLinkTransport(relay, 'relay');
  return relay;
}

function directRefused(coord: object, nodeId: string, session: LinkSession, now: number): boolean {
  const state = states.get(coord);
  if (!state) return false;
  if (now < (state.until.get(nodeId) ?? 0)) return true;
  return now < (state.sessions.get(session) ?? 0);
}

function extendHold(
  state: HoldState,
  nodeId: string,
  session: LinkSession | null,
  now: number
): void {
  const until = now + REMOTE_HOLD_MS;
  const prev = state.until.get(nodeId) ?? 0;
  if (until > prev) state.until.set(nodeId, until);
  if (!session) return;
  const sessionUntil = state.sessions.get(session) ?? 0;
  if (until > sessionUntil) state.sessions.set(session, until);
}

function clearPeerHold(state: HoldState, nodeId: string, session: LinkSession): void {
  state.until.delete(nodeId);
  state.sessions.delete(session);
}

function wrapLocalOpen(state: HoldState, session: LinkSession, peerId: string): void {
  const orig = session.openStream.bind(session);
  session.openStream = async (payload: Uint8Array) => {
    const stream = await orig(payload);
    notePendingMeasure(state, stream, session, peerId);
    return stream;
  };
}

function notePendingMeasure(
  state: HoldState,
  stream: LinkStream,
  session: LinkSession,
  peerId: string
): void {
  void stream.closed.then((info) => {
    if (info.reason !== 'rst' || info.message !== PENDING_MEASURE_REASON) return;
    extendHold(state, peerId, session, Date.now());
  });
}

function watchPromotion(state: HoldState, session: LinkSession, peerId: string): void {
  if (typeof session.ctl?.onMessage !== 'function') return;
  session.ctl.onMessage((bytes) => {
    const msg = parseOpenPayload(bytes);
    if (msg?.t !== ROUTE_PROMOTED_CTL) return;
    clearPeerHold(state, peerId, session);
  });
}

function pickRetiringNonDc(
  rows: Iterable<LivePeer> | undefined,
  held: LinkSession
): LivePeer | null {
  if (!rows) return null;
  let best: LivePeer | null = null;
  for (const row of rows) {
    if (!usableRetiring(row, held)) continue;
    if (!best || comparePeerTransport(row.transport, best.transport) > 0) best = row;
  }
  return best;
}

function usableRetiring(row: LivePeer, held: LinkSession): boolean {
  if (row.finishRetired || row.session === held) return false;
  return row.transport !== 'dc';
}
