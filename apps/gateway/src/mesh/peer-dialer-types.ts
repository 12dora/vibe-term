import type { LinkSession, WebSocketTransportInput } from '@vibeterm/shared/link';
import type { RankableIfaceAddr } from './address-class';
import type { PeerLinkFactory } from './peer-manager-types';
import type { DirectDialLimiter } from './peer-ws-race';
import type { RtcPeerManager } from './rtc';
import type { RtcSignaling } from './rtc/ice';
import type { RtcDialBreaker } from './rtc/rtc-dial-breaker';
import type { PeerTransportKind } from './types';

export type PeerDialerDeps = {
  dcBreaker: RtcDialBreaker;
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
  requireTrusted: (nodeId: string) => void;
  getLink: (nodeId: string) => Promise<LinkSession>;
  maybeUpgrade: (nodeId: string, opts: { cooldown: boolean; userPath?: boolean }) => void;
  nextDcAttemptId: () => string;
  signalingFor: (peerNodeId: string) => RtcSignaling;
  dispatchRtcWake: (peerNodeId: string, opts?: { gated?: boolean }) => void;
  isDegraded?: (nodeId: string) => boolean;
  releaseRtcWakeAttempt: (peerNodeId: string) => void;
  onLocalFingerprintChanged: () => void;
  onPeerEndpointChanged: (nodeId: string) => void;
  listenPort: () => number | undefined;
  allowsOutboundDirect?: (nodeId: string) => boolean;
  allowsInboundDirect?: () => boolean;
  trackRelay?: (session: LinkSession, peerNodeId: string, gen: number) => LinkSession | null;
  offerCandidate?: (input: {
    session: LinkSession;
    peerNodeId: string;
    transport: 'dc';
    initiatedBy: string;
    gen: number;
    remoteAddress: string | null;
    dcAttemptId: string;
    rtcEpoch?: number;
  }) => 'held' | 'installed' | 'rejected';
};

export type PeerDialerOptions = {
  rtc: RtcPeerManager | null;
  linkFactory: PeerLinkFactory | null;
  wsFactory: (url: string) => WebSocketTransportInput | Promise<WebSocketTransportInput>;
  connectTimeoutMs: number;
  dialLimiter: DirectDialLimiter;
  interfacesFn: () => Record<string, RankableIfaceAddr[] | undefined>;
  refreshLocalInterfaces: (() => Record<string, RankableIfaceAddr[] | undefined>) | null;
  deps: PeerDialerDeps;
};
