import type { LinkSession, LinkStream } from '@vibeterm/shared/link';
import { encodeJsonBytes } from './ctl';
import { type PeerInboundStreamHost, handlePeerInboundStream } from './peer-live-inbound';
import { PEER_RETIRE_MAX_MS, type PeerManagerState } from './peer-manager-state';
import { parseOpenPayload } from './peer-protocol';
import type { LivePeer } from './peer-reconnect-wake';
import { quiet } from './peer-ws-race';
import { rememberLinkTransport } from './pending-measure-hold';
import { isDirectTransport } from './route-policy';
import { classifyOpenPayload } from './stream-targets';
import type { MeshScheduler, PeerTransportKind } from './types';

const boundSideRelays = new WeakSet<LinkSession>();
const accountedSideRelays = new WeakSet<LinkSession>();

type SideLoad = {
  in: number;
  out: number;
  retiring: boolean;
  closed: boolean;
  onIdle: (() => void) | null;
};

const sideLoads = new WeakMap<LinkSession, SideLoad>();

function sideLoad(session: LinkSession): SideLoad {
  let row = sideLoads.get(session);
  if (!row) {
    row = { in: 0, out: 0, retiring: false, closed: false, onIdle: null };
    sideLoads.set(session, row);
  }
  return row;
}

function bumpSide(session: LinkSession, field: 'in' | 'out', delta: number): void {
  const row = sideLoad(session);
  row[field] = Math.max(0, row[field] + delta);
  if (row.retiring && row.in + row.out === 0) row.onIdle?.();
}

/** 旁路中继的出站和入站都算上。测量窗结束时用来决定是立刻关还是排空。 */
export function attachSideRelayAccounting(session: LinkSession): void {
  if (accountedSideRelays.has(session)) return;
  accountedSideRelays.add(session);
  const orig = session.openStream.bind(session);
  session.openStream = async (payload: Uint8Array) => {
    const stream = await orig(payload);
    bumpSide(session, 'out', 1);
    void stream.closed.then(() => bumpSide(session, 'out', -1));
    return stream;
  };
  session.onStream((stream) => {
    bumpSide(session, 'in', 1);
    void stream.closed.then(() => bumpSide(session, 'in', -1));
  });
}

/** 空闲立刻关。还有流就等到归零，最多 PEER_RETIRE_MAX_MS。 */
export function retireSideRelay(
  session: LinkSession,
  reason: string,
  scheduler: MeshScheduler,
  maxMs = PEER_RETIRE_MAX_MS
): void {
  const row = sideLoad(session);
  const close = () => {
    if (row.closed) return;
    row.closed = true;
    row.onIdle = null;
    quiet(() => session.close(reason));
  };
  if (row.in + row.out === 0) {
    close();
    return;
  }
  row.retiring = true;
  const handle = scheduler.interval(() => {
    handle.clear();
    close();
  }, maxMs);
  row.onIdle = () => {
    handle.clear();
    close();
  };
}

/** 测量期间旁路拨中继：live 仍是 DC，这条 relay 只给用户流用。 */
export function shouldParkBesideRelay(
  state: PeerManagerState,
  prev: LivePeer | undefined,
  transport: PeerTransportKind
): prev is LivePeer {
  if (!prev || transport !== 'relay') return false;
  if (!isDirectTransport(prev.transport)) return false;
  return state.besideRelayDial.has(prev.peerNodeId);
}

export function parkBesideRelay(
  state: PeerManagerState,
  peerId: string,
  session: LinkSession
): void {
  const prev = state.sideRelays.get(peerId);
  if (prev && prev !== session) quiet(() => prev.close('replaced'));
  state.sideRelays.set(peerId, session);
  rememberLinkTransport(session, 'relay');
  attachSideRelayAccounting(session);
  state.sideRelayAttach?.(session, peerId);
  void session.closed.then(() => {
    if (state.sideRelays.get(peerId) === session) state.sideRelays.delete(peerId);
  });
}

type SideRelayBind = {
  state: PeerManagerState;
  peerId: string;
  session: LinkSession;
  host: PeerInboundStreamHost;
  maxStreams: number;
  open: { n: number };
};

/**
 * 测量方的 live 仍可能是旧中继。我们拨出的这条同级 relay 一旦赢了同时拨号，
 * 就会变成对端的 live，对端的用户流和 ping 都打在这条 session 上。
 * 本端不把它装成 live（DC 还在），但必须分发入站并回 ping。
 */
export function watchSideRelay(
  state: PeerManagerState,
  host: PeerInboundStreamHost,
  maxStreams: number
): void {
  state.sideRelayAttach = (session, peerId) =>
    bindSideRelayInbound(state, peerId, session, host, maxStreams);
}

export function bindSideRelayInbound(
  state: PeerManagerState,
  peerId: string,
  session: LinkSession,
  host: PeerInboundStreamHost,
  maxStreams: number
): void {
  if (boundSideRelays.has(session)) return;
  boundSideRelays.add(session);
  const bind: SideRelayBind = { state, peerId, session, host, maxStreams, open: { n: 0 } };
  session.onStream((stream) => acceptSideStream(bind, stream));
  session.ctl.onMessage((bytes) => answerSidePing(bind, bytes));
}

export function releaseSideRelay(
  state: PeerManagerState,
  nodeId: string,
  plan: { terminal: boolean; wasDc: boolean },
  reason: string,
  install: (session: LinkSession) => void
): void {
  const session = state.sideRelays.get(nodeId);
  if (!session) return;
  state.sideRelays.delete(nodeId);
  state.besideRelayDial.delete(nodeId);
  if (plan.wasDc && !plan.terminal && !state.live.has(nodeId)) {
    install(session);
    return;
  }
  if (state.live.get(nodeId)?.session === session) return;
  quiet(() => session.close(reason));
}

function acceptSideStream(bind: SideRelayBind, stream: LinkStream): void {
  if (sideRelayIsLive(bind)) return;
  const kind = classifyOpenPayload(stream.openPayload);
  if (kind === 'unknown' || kind === 'relay') {
    stream.reset('unknown-stream-type');
    return;
  }
  if (bind.open.n >= bind.maxStreams) {
    stream.reset('too-many-streams');
    return;
  }
  bind.open.n += 1;
  void stream.closed.then(() => {
    bind.open.n = Math.max(0, bind.open.n - 1);
  });
  handlePeerInboundStream(bind.host, bind.peerId, stream);
}

function answerSidePing(bind: SideRelayBind, bytes: Uint8Array): void {
  if (sideRelayIsLive(bind)) return;
  const msg = parseOpenPayload(bytes);
  if (msg?.t !== 'ping') return;
  const sentAt = typeof msg.sentAt === 'number' ? msg.sentAt : null;
  const payload = sentAt == null ? { t: 'pong' } : { t: 'pong', sentAt };
  quiet(() => bind.session.ctl.send(encodeJsonBytes(payload)));
}

function sideRelayIsLive(bind: SideRelayBind): boolean {
  return bind.state.live.get(bind.peerId)?.session === bind.session;
}
