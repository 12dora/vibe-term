import type { LinkSession } from '@tmex/shared/link';
import type { PeerTransportKind } from './types';

export type LivePeer = {
  session: LinkSession;
  peerNodeId: string;
  transport: PeerTransportKind;
  initiatedBy: string;
  generation: number;
  streams: number;
  lastStreamAt: number;
  idleTimer: { clear: () => void } | null;
  pingTimer: { clear: () => void } | null;
  missedPongs: number;
  lastInboundFrameAt: number;
  retiring: boolean;
  retireReason: string;
  retiredAt: number;
  zeroStreamsSince: number;
  gotQuiesceAck: boolean;
  gotPeerQuiesce: boolean;
  retireTimer: { clear: () => void } | null;
  finishRetired: boolean;
  lastAdvertisedStatusJson: string;
  unsubRtc: (() => void) | null;
  sendKey?: Uint8Array;
  recvKey?: Uint8Array;
  quiesceCapable: boolean;
  helloReplied: boolean;
  probeSent: boolean;
  remoteAddress: string | null;
  rttMs: number | null;
  pingSentAt: number | null;
  lastRttEmitAt: number;
  lastEmittedRttMs: number | null;
  linkSinceAt: number;
  dcAttemptId: string | null;
};

const DRAIN_DROP_REASONS = new Set(['missed-pong', 'idle']);

export function isDrainRetireReason(reason: string): boolean {
  return DRAIN_DROP_REASONS.has(reason);
}

export type PeerDropPlan = {
  drain: boolean;
  terminal: boolean;
  revoked: boolean;
  wasDc: boolean;
  countDcFailure: boolean;
};

export function peerDropPlan(
  live: LivePeer | undefined,
  reason: string,
  stopped: boolean,
  intentionalDcLoss: boolean
): PeerDropPlan {
  const wasDc = live?.transport === 'dc';
  const revoked = reason === 'revoked';
  return {
    drain: Boolean(live && live.streams > 0 && DRAIN_DROP_REASONS.has(reason)),
    terminal: stopped || revoked,
    revoked,
    wasDc,
    countDcFailure: wasDc && !intentionalDcLoss,
  };
}

export class PeerReconnectWake {
  private readonly disconnected = new Set<string>();
  private readonly pending = new Set<string>();

  installed(peer: LivePeer, wake: (nodeId: string) => void): void {
    const reconnected = this.disconnected.delete(peer.peerNodeId);
    if (peer.transport === 'dc') this.pending.delete(peer.peerNodeId);
    else if (reconnected) this.pending.add(peer.peerNodeId);
    this.ready(peer, wake);
  }

  lost(nodeId: string, disabledLiveLost: boolean, replacementAvailable: boolean): void {
    if (disabledLiveLost && !replacementAvailable) this.disconnected.add(nodeId);
  }

  ready(peer: LivePeer | undefined, wake: (nodeId: string) => void): void {
    if (
      !peer ||
      peer.transport === 'dc' ||
      !peer.quiesceCapable ||
      !this.pending.delete(peer.peerNodeId)
    ) {
      return;
    }
    wake(peer.peerNodeId);
  }

  clear(nodeId: string): void {
    this.disconnected.delete(nodeId);
    this.pending.delete(nodeId);
  }

  reset(): void {
    this.disconnected.clear();
    this.pending.clear();
  }
}
