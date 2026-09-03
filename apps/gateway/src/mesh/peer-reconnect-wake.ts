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
  retiring: boolean;
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
