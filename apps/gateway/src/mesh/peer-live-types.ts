import type { LinkSession } from '@vibeterm/shared/link';
import type { NodeSessionStore } from '../auth/node-session-store';
import type { WebSocketServer } from '../ws';
import type { UpgradeGate } from './peer-dc-upgrade';
import type { LivePeer } from './peer-reconnect-wake';
import type { IncomingWakeGate } from './peer-rtc-wake';
import type { RelayDialBreaker, RelayDialBreakerSnapshot } from './relay-dial-breaker';
import type { TrackIntercept, TrackInterceptInput } from './route-degrade';
import type { RtcDialBreaker, RtcDialBreakerSnapshot } from './rtc/rtc-dial-breaker';
import type { DispatchHttp, PeerReach, PeerTransportKind } from './types';
import type { GatewaySessionClose } from './ws-stream-target';

export type PeerLiveRegistryDeps = {
  dcBreaker: RtcDialBreaker;
  relayBreaker?: RelayDialBreaker;
  sendPeerCtl: (live: LivePeer, msg: Record<string, unknown>) => void;
  handlePeerCtl: (live: LivePeer, bytes: Uint8Array) => void;
  sendPeerStatus: (live: LivePeer) => void;
  sendLinkHello: (live: LivePeer) => void;
  restartQuiesce: (live: LivePeer) => void;
  probeQuiesce: (live: LivePeer) => void;
  clearDirectFailure: (nodeId: string) => void;
  parkInbound: (
    peerNodeId: string,
    session: LinkSession,
    transport: PeerTransportKind,
    initiatedBy: string,
    gen: number,
    remoteAddress: string | null
  ) => void;
  dropParked: (nodeId: string, reason: string) => void;
  activateParked: (nodeId: string) => void;
  retirePeer: (prev: LivePeer, reason: string) => void;
  finishRetire: (live: LivePeer, reason?: string) => void;
  armRetireTimer: (live: LivePeer, reason?: string) => void;
  maybeFinishRetire: (live: LivePeer, reason?: string) => void;
  nextDcAttemptId: () => string;
  armDcHealthTimer: (nodeId: string, attemptId: string) => void;
  cancelDcHealthTimer: (nodeId: string) => void;
  armDcUpgradeRetry: (nodeId: string) => void;
  cancelDcUpgradeRetry: (nodeId: string) => void;
  ensureGate: (nodeId: string) => UpgradeGate;
  ensureIncomingWakeGate: (nodeId: string) => IncomingWakeGate;
  onPeerReconnected: (nodeId: string) => void;
  notifyTransport: (nodeId: string) => void;
  notifyLive: (nodeId: string, session: LinkSession) => void;
  onRttSample: (live: LivePeer, sampleMs: number) => void;
  interceptTrack?: (input: TrackInterceptInput) => TrackIntercept;
};

export type PeerLiveRegistryOptions = {
  idleMs: number;
  maxConcurrentStreams: number;
  sessionStore?: NodeSessionStore;
  dispatchHttp: () => DispatchHttp | undefined;
  wsServer?: WebSocketServer;
  onGatewaySession:
    | ((
        session: import('../ws/gateway-session').GatewaySession,
        auth: { sid: string; uid: string; via: string; cid?: string }
      ) => boolean | undefined)
    | null;
  onGatewaySessionClose:
    | ((
        session: import('../ws/gateway-session').GatewaySession,
        close?: GatewaySessionClose
      ) => void)
    | null;
  onLinkInfo:
    | ((info: {
        nodeId: string;
        reach: PeerReach;
        transport: PeerTransportKind | null;
        rttMs: number | null;
        dcBreaker?: RtcDialBreakerSnapshot;
        relayBreaker?: RelayDialBreakerSnapshot;
      }) => void)
    | null;
  deps: PeerLiveRegistryDeps;
};
