import type { LinkSession, LinkStream } from '@vibeterm/shared/link';
import type { MeshRouteMode } from '@vibeterm/shared/net';
import { encodeJsonBytes } from './ctl';
import {
  PEER_PING_INTERVAL_MS,
  PEER_RETIRE_MAX_MS,
  type PeerManagerState,
  comparePeerTransport,
} from './peer-manager-state';
import type { LivePeer } from './peer-reconnect-wake';
import { attachSideRelayAccounting, retireSideRelay } from './peer-side-relay';
import { quiet } from './peer-ws-race';
import { ROUTE_PROMOTE_SAMPLES, isDirectTransport } from './route-policy';
import { noteSessionRefusal, onRoutePromoted } from './session-binding';
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
  borrowed: Map<string, Promise<LinkSession | null>>;
  expiryGen: Map<string, number>;
  holdSession: Map<string, LinkSession>;
  unsub: (() => void) | null;
  unsubPromoted: (() => void) | null;
  coord: object;
};

type MeasureHost = {
  ports?: {
    state?: PeerManagerState;
    openRelay?: (nodeId: string) => Promise<LinkSession>;
    openUntrackedRelay?: (nodeId: string) => Promise<LinkSession>;
    parkSide?: (peerId: string, session: LinkSession) => void;
  };
};

const listeners = new Set<(notice: RefusalNotice) => void>();
const states = new WeakMap<object, HoldState>();
const linkTransport = new WeakMap<LinkSession, PeerTransportKind>();

function holdState(coord: object): HoldState {
  let state = states.get(coord);
  if (!state) {
    state = {
      until: new Map(),
      sessions: new WeakMap(),
      watched: new WeakSet(),
      borrowed: new Map(),
      expiryGen: new Map(),
      holdSession: new Map(),
      unsub: null,
      unsubPromoted: null,
      coord,
    };
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
  state.unsubPromoted?.();
  state.unsub = subscribeTransportRefused((notice) => {
    extendHold(state, notice.nodeId, notice.session, notice.now);
  });
  state.unsubPromoted = onRoutePromoted((peerId, session) => {
    const id = holdIdForSession(state, peerId, session);
    if (!id) return;
    clearPeerHold(state, id, session);
  });
}

export function detachRemoteHold(coord: object): void {
  const state = states.get(coord);
  if (!state) return;
  state.unsub?.();
  state.unsubPromoted?.();
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
}

export async function resolveRefusedUserLink(
  coord: object,
  live: LivePeer,
  opts: {
    now: number;
    mode: MeshRouteMode;
    retiring: Iterable<LivePeer> | undefined;
    dialRelay: () => Promise<LinkSession | null>;
  }
): Promise<LinkSession | null> {
  if (!isDirectTransport(live.transport)) return null;
  if (!directRefused(coord, live.peerNodeId, live.session, opts.now)) return null;
  const fallback = refusedFallback(coord, live, opts.retiring);
  if (fallback) return fallback;
  // 只有节点级测量窗才旁路拨中继。parked 只绑在这一条 session 上，拨出来也会被 hold-expired 丢掉。
  if (opts.mode !== 'auto' || !holdStillOpen(coord, live.peerNodeId, opts.now)) return null;
  return opts.dialRelay();
}

/** auto 模式下为用户流旁路拨一条中继：不把 DC 退役，也不记 route degraded。 */
export function borrowRelayForRemoteHold(
  coord: object,
  peerId: string
): Promise<LinkSession | null> {
  const state = holdState(coord);
  const cached = managerOf(coord)?.sideRelays.get(peerId);
  if (cached) return Promise.resolve(cached);
  const inflight = state.borrowed.get(peerId);
  if (inflight) return inflight;
  const open = (coord as MeasureHost).ports?.openRelay;
  if (!open) return Promise.resolve(null);
  const pending = dialBeside(coord, peerId, open);
  state.borrowed.set(peerId, pending);
  return pending.finally(() => {
    if (state.borrowed.get(peerId) === pending) state.borrowed.delete(peerId);
  });
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
  publishMeasureUntil(state, nodeId, state.until.get(nodeId) ?? until);
  armHoldExpiry(state, nodeId);
  if (!session) return;
  state.holdSession.set(nodeId, session);
  const sessionUntil = state.sessions.get(session) ?? 0;
  if (until > sessionUntil) state.sessions.set(session, until);
}

function holdIdForSession(state: HoldState, peerId: string, session: LinkSession): string | null {
  if (state.holdSession.get(peerId) === session) return peerId;
  for (const [id, held] of state.holdSession) if (held === session) return id;
  return null;
}

function clearPeerHold(state: HoldState, nodeId: string, session: LinkSession): void {
  state.until.delete(nodeId);
  state.expiryGen.delete(nodeId);
  state.holdSession.delete(nodeId);
  state.sessions.delete(session);
  publishMeasureUntil(state, nodeId, null);
  closeSideRelay(state, nodeId, 'route-promoted');
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
    const message = info.message ?? '';
    if (info.reason === 'rst' && message === 'stale-link') {
      noteSessionRefusal(session, 'stale-link', peerId);
      return;
    }
    if (info.reason === 'rst' && message === 'parked') {
      holdSessionOnly(state, session);
      return;
    }
    if (info.reason !== 'rst' || message !== PENDING_MEASURE_REASON) return;
    extendHold(state, peerId, session, Date.now());
  });
}

function holdSessionOnly(state: HoldState, session: LinkSession): void {
  const until = Date.now() + PEER_RETIRE_MAX_MS;
  const prev = state.sessions.get(session) ?? 0;
  if (until > prev) state.sessions.set(session, until);
}

function refusedFallback(
  coord: object,
  live: LivePeer,
  retiring: Iterable<LivePeer> | undefined
): LinkSession | null {
  const row = pickRetiringNonDc(retiring, live.session);
  if (row) {
    rememberLinkTransport(row.session, row.transport);
    return row.session;
  }
  const side = managerOf(coord)?.sideRelays.get(live.peerNodeId);
  if (!side) return null;
  rememberLinkTransport(side, 'relay');
  return side;
}

function managerOf(coord: object): PeerManagerState | undefined {
  return (coord as MeasureHost).ports?.state;
}

function publishMeasureUntil(state: HoldState, nodeId: string, until: number | null): void {
  const map = managerOf(state.coord)?.remoteMeasureUntil;
  if (!map) return;
  if (until == null) map.delete(nodeId);
  else map.set(nodeId, until);
}

function closeSideRelay(state: HoldState, nodeId: string, reason: string): void {
  const manager = managerOf(state.coord);
  if (!manager) return;
  const session = manager.sideRelays.get(nodeId);
  if (!session) return;
  manager.sideRelays.delete(nodeId);
  if (manager.live.get(nodeId)?.session === session) return;
  retireSideRelay(session, reason, manager.scheduler);
}

function holdStillOpen(coord: object, peerId: string, now = Date.now()): boolean {
  return now < (states.get(coord)?.until.get(peerId) ?? 0);
}

function armHoldExpiry(state: HoldState, nodeId: string): void {
  const manager = managerOf(state.coord);
  if (!manager) return;
  const until = state.until.get(nodeId) ?? 0;
  const gen = (state.expiryGen.get(nodeId) ?? 0) + 1;
  state.expiryGen.set(nodeId, gen);
  const delay = Math.max(1, until - Date.now());
  const handle = manager.scheduler.interval(() => {
    handle.clear();
    expireHold(state, nodeId, gen);
  }, delay);
}

function expireHold(state: HoldState, nodeId: string, gen: number): void {
  if (states.get(state.coord) !== state) return;
  if (state.expiryGen.get(nodeId) !== gen) return;
  if ((state.until.get(nodeId) ?? 0) === 0) return;
  state.until.delete(nodeId);
  state.expiryGen.delete(nodeId);
  publishMeasureUntil(state, nodeId, null);
  closeSideRelay(state, nodeId, 'hold-expired');
}

async function dialBeside(
  coord: object,
  peerId: string,
  open: (nodeId: string) => Promise<LinkSession>
): Promise<LinkSession | null> {
  const manager = managerOf(coord);
  const untracked = (coord as MeasureHost).ports?.openUntrackedRelay ?? open;
  try {
    const session = await untracked(peerId);
    if (manager?.stopped) {
      quiet(() => session.close('stopped'));
      return null;
    }
    if (!holdStillOpen(coord, peerId)) {
      quiet(() => session.close('hold-expired'));
      return null;
    }
    const park = (coord as MeasureHost).ports?.parkSide;
    if (park) park(peerId, session);
    else rememberSide(manager, peerId, session);
    return session;
  } catch {
    return null;
  }
}

function rememberSide(
  manager: PeerManagerState | undefined,
  peerId: string,
  session: LinkSession
): void {
  if (!manager) return;
  if (manager.sideRelays.get(peerId) === session) return;
  manager.sideRelays.set(peerId, session);
  rememberLinkTransport(session, 'relay');
  attachSideRelayAccounting(session);
  const closed = session.closed;
  if (!closed || typeof closed.then !== 'function') return;
  void closed.then(() => {
    if (manager.sideRelays.get(peerId) === session) manager.sideRelays.delete(peerId);
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
