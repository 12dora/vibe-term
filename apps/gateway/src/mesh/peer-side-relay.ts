import type { LinkSession, LinkStream } from '@vibeterm/shared/link';
import { type PeerInboundStreamHost, handlePeerInboundStream } from './peer-live-inbound';
import { PEER_RETIRE_MAX_MS, type PeerManagerState } from './peer-manager-state';
import { quiet } from './peer-ws-race';
import { rememberLinkTransport } from './pending-measure-hold';
import { claimSession } from './session-binding';
import { classifyOpenPayload } from './stream-targets';
import type { MeshScheduler } from './types';
import { noteRelaySessionStream } from './uplink-relay-drain';

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
    noteRelaySessionStream(session, stream);
    bumpSide(session, 'out', 1);
    void stream.closed.then(() => bumpSide(session, 'out', -1));
    return stream;
  };
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

/** dialBeside 显式停成 side 角色。已经是 live / retiring 的 session 不再停一次。 */
export function parkSideRelay(
  state: PeerManagerState,
  peerId: string,
  session: LinkSession,
  host: PeerInboundStreamHost,
  maxStreams: number
): void {
  if (sessionAlreadyOwned(state, peerId, session)) return;
  const prev = state.sideRelays.get(peerId);
  if (prev && prev !== session) retireSideRelay(prev, 'replaced', state.scheduler);
  state.sideRelays.set(peerId, session);
  rememberLinkTransport(session, 'relay');
  attachSideRelayAccounting(session);
  claimSession(session, {
    role: 'side',
    peerId,
    owner: session,
    onStream: (stream) => acceptSideStream(host, peerId, session, maxStreams, stream),
  });
  void session.closed.then(() => {
    if (state.sideRelays.get(peerId) === session) state.sideRelays.delete(peerId);
  });
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
  if (reason === 'idle') {
    quiet(() => session.close(reason));
    return;
  }
  if (plan.wasDc && !plan.terminal && !state.live.has(nodeId)) {
    install(session);
    return;
  }
  if (state.live.get(nodeId)?.session === session) return;
  quiet(() => session.close(reason));
}

function sessionAlreadyOwned(
  state: PeerManagerState,
  peerId: string,
  session: LinkSession
): boolean {
  if (state.live.get(peerId)?.session === session) return true;
  const retiring = state.retiring.get(peerId);
  if (!retiring) return false;
  for (const row of retiring) if (row.session === session) return true;
  return false;
}

function acceptSideStream(
  host: PeerInboundStreamHost,
  peerId: string,
  session: LinkSession,
  maxStreams: number,
  stream: LinkStream
): void {
  if (stream.dead) return;
  const kind = classifyOpenPayload(stream.openPayload);
  if (kind === 'unknown' || kind === 'relay') {
    stream.reset('unknown-stream-type');
    return;
  }
  noteRelaySessionStream(session, stream);
  if (sideLoad(session).in >= maxStreams) {
    stream.reset('too-many-streams');
    return;
  }
  bumpSide(session, 'in', 1);
  void stream.closed.then(() => bumpSide(session, 'in', -1));
  handlePeerInboundStream(host, peerId, stream);
}
