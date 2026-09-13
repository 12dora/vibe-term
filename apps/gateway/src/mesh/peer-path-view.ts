import type { LinkSession } from '@vibeterm/shared/link';
import { classifyPeerReach } from './address-class';
import { encodeJsonBytes } from './ctl';
import { directFailureView } from './peer-direct-attempt';
import { type PeerManagerState, isPeerTrusted } from './peer-manager-state';
import type { PeerLinkDetail } from './peer-manager-types';
import type { LivePeer } from './peer-reconnect-wake';
import { quiet } from './peer-ws-race';
import type { RelayPresenceIndex } from './relay-presence-types';
import type { RtcDialBreakerSnapshot } from './rtc/rtc-dial-breaker';
import { NodeUnreachableError, type PeerReach } from './types';

export function viaRelayOfLive(live: LivePeer | undefined): string | null {
  return live?.transport === 'relay' ? (live.viaRelay ?? null) : null;
}

export function sendPeerCtlQuiet(live: LivePeer, msg: Record<string, unknown>): void {
  quiet(() => {
    void Promise.resolve(live.session.ctl.send(encodeJsonBytes(msg))).catch(() => undefined);
  });
}

export function liveSessionOf(
  state: PeerManagerState,
  nodeId: string,
  onRevoked: (nodeId: string) => void
): LinkSession | null {
  if (!isPeerTrusted(state, nodeId)) {
    if (state.userStore.getCert(nodeId)?.revokedLogSeq != null) onRevoked(nodeId);
    return null;
  }
  return state.live.get(nodeId)?.session ?? null;
}

export function requirePeerAdmitted(
  state: PeerManagerState,
  nodeId: string,
  onRevoked: (nodeId: string) => void
): void {
  const cert = state.userStore.getCert(nodeId);
  if (cert?.revokedLogSeq != null) {
    onRevoked(nodeId);
    throw new NodeUnreachableError(nodeId, 'revoked');
  }
  if (!cert || !state.uplink.userId || cert.userId !== state.uplink.userId) {
    throw new NodeUnreachableError(nodeId, 'not admitted');
  }
}

export function relayPresenceOfIndex(
  index: RelayPresenceIndex | undefined,
  nodeId: string
): string[] | undefined {
  return index?.relaysFor(nodeId);
}

export function listPeerReach(
  state: PeerManagerState,
  onRevoked: (nodeId: string) => void
): Map<string, PeerReach> {
  const out = new Map<string, PeerReach>();
  for (const peer of state.userStore.listPeers()) {
    if (!isPeerTrusted(state, peer.nodeId)) continue;
    out.set(peer.nodeId, null);
  }
  for (const [id, live] of state.live) {
    if (!isPeerTrusted(state, id)) {
      if (state.userStore.getCert(id)?.revokedLogSeq != null) onRevoked(id);
      continue;
    }
    out.set(id, classifyPeerReach(live.transport, live.remoteAddress));
  }
  return out;
}

export function peerLinkDetailFromState(
  state: PeerManagerState,
  nodeId: string,
  hubHost: string | null,
  dcBreaker: RtcDialBreakerSnapshot
): PeerLinkDetail {
  return peerLinkDetailOf({
    live: state.live.get(nodeId),
    hubHost,
    lastDirectAttempt: state.lastDirectAttempt.get(nodeId),
    dcBreaker,
    relayPresence: state.relayPresence,
    nodeId,
  });
}

export function peerLinkDetailOf(input: {
  live: LivePeer | undefined;
  hubHost: string | null;
  lastDirectAttempt: Parameters<typeof directFailureView>[0];
  dcBreaker: RtcDialBreakerSnapshot;
  relayPresence?: RelayPresenceIndex;
  nodeId: string;
}): PeerLinkDetail {
  return {
    peerAddress:
      input.live?.transport === 'relay' ? input.hubHost : (input.live?.remoteAddress ?? null),
    linkSinceAt: input.live?.linkSinceAt ?? null,
    endpoints: [],
    directFailure: directFailureView(input.lastDirectAttempt),
    dcBreaker: input.dcBreaker,
    viaRelay: viaRelayOfLive(input.live),
    relayPresence: relayPresenceOfIndex(input.relayPresence, input.nodeId),
  };
}
