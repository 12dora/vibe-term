import type { LinkSession } from '@vibeterm/shared/link';
import { type RankableIfaceAddr, localNetworkFingerprint } from './address-class';
import { parseEndpoints } from './peer-dc-upgrade';
import { finishDirectAttemptRecord } from './peer-dialer-dc-gate';
import { openPeerRelaySession } from './peer-dialer-relay';
import type { PeerDialerDeps } from './peer-dialer-types';
import { type DirectAttemptRecord, emptyDirectAttempt } from './peer-direct-attempt';
import { canonicalEndpointSet } from './peer-endpoint-backoff';
import type { PeerManagerState } from './peer-manager-state';
import type { WsSecureDialOpts } from './peer-ws-reroll-dial';
import type { RtcPeerManager } from './rtc';
import { NodeUnreachableError } from './types';

export type DialerProbeCtx = {
  state: PeerManagerState;
  deps: PeerDialerDeps;
  rtc: RtcPeerManager | null;
  fingerprint: () => string;
  setFingerprint: (next: string) => void;
  interfaces: () => Record<string, RankableIfaceAddr[] | undefined>;
  dialWs: (
    nodeId: string,
    gen: number,
    signal: AbortSignal,
    attempt: DirectAttemptRecord,
    opts?: WsSecureDialOpts
  ) => Promise<LinkSession | null>;
};

export async function forceProbeDirect(
  ctx: DialerProbeCtx,
  nodeId: string,
  endpoints?: string[]
): Promise<LinkSession | null> {
  ctx.deps.requireTrusted(nodeId);
  if (ctx.state.stopped) throw new NodeUnreachableError(nodeId, 'peer manager stopped');
  const gen = ctx.state.generation;
  const attempt = emptyDirectAttempt(ctx.state.scheduler.now());
  const rtcOn = ctx.rtc?.available === true;
  const done = (session: LinkSession | null) =>
    finishDirectAttemptRecord(ctx.state, nodeId, attempt, session, null, undefined, rtcOn);
  try {
    const session = await ctx.dialWs(nodeId, gen, ctx.state.stopAbort.signal, attempt, {
      bypassBackoff: true,
      endpoints,
    });
    done(session);
    return session;
  } catch (err) {
    done(null);
    if (err instanceof NodeUnreachableError) throw err;
    throw new NodeUnreachableError(nodeId, err instanceof Error ? err.message : 'unreachable');
  }
}

export function syncDialerFingerprint(ctx: DialerProbeCtx): void {
  const next = localNetworkFingerprint(ctx.interfaces());
  if (ctx.fingerprint() && next !== ctx.fingerprint()) {
    ctx.state.endpointBackoff.resetAll();
    ctx.state.uplink.resetBackoff();
    ctx.deps.onLocalFingerprintChanged();
  }
  ctx.setFingerprint(next);
}

export function syncDialerPeerEndpoints(ctx: DialerProbeCtx, nodeId: string): void {
  const cached = ctx.state.userStore.getPeer(nodeId);
  const urls = cached ? parseEndpoints(cached.endpointsJson, ctx.deps.listenPort()) : [];
  const next = canonicalEndpointSet(urls);
  const prev = ctx.state.advertisedEndpointSet.get(nodeId);
  if (prev !== undefined && prev !== next) {
    ctx.state.endpointBackoff.resetNode(nodeId);
    ctx.deps.onPeerEndpointChanged(nodeId);
  }
  ctx.state.advertisedEndpointSet.set(nodeId, next);
}

type RememberKeys = (session: LinkSession, sendKey?: Uint8Array, recvKey?: Uint8Array) => void;

export function dialRelayUntrackedSession(
  state: PeerManagerState,
  remember: RememberKeys,
  nodeId: string
): Promise<LinkSession> {
  return openPeerRelaySession({
    host: state,
    nodeId,
    gen: state.generation,
    rememberKeys: remember,
    track: (session) => session,
  });
}

export function dialRelayOnlySession(
  state: PeerManagerState,
  deps: PeerDialerDeps,
  remember: RememberKeys,
  nodeId: string,
  opts?: { background?: boolean }
): Promise<LinkSession> {
  const existing = state.live.get(nodeId);
  if (existing?.transport === 'relay') return Promise.resolve(existing.session);
  return openPeerRelaySession({
    host: state,
    nodeId,
    gen: state.generation,
    rememberKeys: remember,
    track: (session, id, g) =>
      deps.trackRelay
        ? deps.trackRelay(session, id, g)
        : deps.track(session, id, 'relay', state.identity.nodeId, g),
    background: opts?.background === true,
  });
}
