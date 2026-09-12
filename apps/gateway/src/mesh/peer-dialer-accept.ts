import type { LinkSession, LinkStream, ServerSocketAdapter } from '@vibeterm/shared/link';
import { formatSafeErrorLog } from '../auth/cookies';
import { stamp } from './mesh-log';
import { type PeerManagerState, peerStale } from './peer-manager-state';
import { handshakeRelay, handshakeWsDirect } from './peer-protocol';
import { quiet } from './peer-ws-race';
import type { PeerTransportKind } from './types';

export type AcceptTrack = (
  session: LinkSession,
  peerNodeId: string,
  transport: PeerTransportKind,
  initiatedBy: string,
  gen: number,
  quiesceCapable?: boolean,
  remoteAddress?: string | null,
  dcAttemptId?: string | null
) => LinkSession | null;

export type AcceptDeps = {
  state: PeerManagerState;
  track: AcceptTrack;
  rememberKeys: (session: LinkSession, sendKey?: Uint8Array, recvKey?: Uint8Array) => void;
};

/** 入站 ws-secure：握手成功即按 ws-secure 登记，对端为发起方。 */
export async function acceptDirectSession(
  deps: AcceptDeps,
  socket: ServerSocketAdapter,
  remoteAddress: string | null
): Promise<void> {
  const { state } = deps;
  const gen = state.generation;
  try {
    const result = await handshakeWsDirect({
      socket,
      role: 'acceptor',
      identity: state.identity,
      userStore: state.userStore,
    });
    if (peerStale(state, gen)) {
      quiet(() => result.session.close('stopped'));
      return;
    }
    deps.rememberKeys(result.session, result.sendKey, result.recvKey);
    deps.track(
      result.session,
      result.peerNodeId,
      'ws-secure',
      result.peerNodeId,
      gen,
      false,
      remoteAddress
    );
  } catch {
    quiet(() => socket.close(1000, 'handshake-failed'));
  }
}

/** 入站 relay 流：握手成功后登记 relay 链路，并记住实际经过的中继。 */
export async function acceptRelaySession(
  deps: AcceptDeps,
  stream: LinkStream,
  from: string,
  viaRelay?: string
): Promise<void> {
  const { state } = deps;
  const gen = state.generation;
  try {
    const result = await handshakeRelay({
      stream,
      role: 'acceptor',
      identity: state.identity,
      userStore: state.userStore,
    });
    if (peerStale(state, gen)) {
      quiet(() => result.session.close('stopped'));
      return;
    }
    deps.rememberKeys(result.session, result.sendKey, result.recvKey);
    deps.track(result.session, result.peerNodeId, 'relay', from || result.peerNodeId, gen);
    if (viaRelay) {
      const live = state.live.get(result.peerNodeId);
      if (live?.transport === 'relay') live.viaRelay = viaRelay;
    }
  } catch (err) {
    console.warn(stamp(`[mesh][relay] accept failed node=${from} ${formatSafeErrorLog(err)}`));
    quiet(() => stream.reset('handshake-failed'));
  }
}
