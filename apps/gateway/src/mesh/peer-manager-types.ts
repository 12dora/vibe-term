import type { LinkSession, WebSocketTransportInput } from '@tmex/shared/link';
import type { NodeSessionStore } from '../auth/node-session-store';
import type { UserStore } from '../auth/user-store';
import type { WebSocketServer } from '../ws';
import type { GatewaySession } from '../ws/gateway-session';
import type { RankableIfaceAddr } from './address-class';
import type { RtcSignalMessage } from './mesh-deps';
import type { PeerEndpointBackoff } from './peer-endpoint-backoff';
import type { DirectDialLimiter } from './peer-ws-race';
import type { RtcPeerManager } from './rtc';
import type { RtcDialBreakerSnapshot } from './rtc/rtc-dial-breaker';
import type {
  DispatchHttp,
  KeyLogApplier,
  MeshIdentity,
  MeshScheduler,
  PeerReach,
  PeerTransportKind,
  UplinkStatus,
} from './types';
import type { UplinkClient } from './uplink-client';
import type { UplinkPool } from './uplink-pool';

export type PeerManagerOptions = {
  identity: MeshIdentity;
  userStore: UserStore;
  uplink: UplinkClient | UplinkPool;
  peerPort: number;
  now?: () => number;
  scheduler?: MeshScheduler;
  keyLogApplier?: KeyLogApplier;
  statusProvider?: () => UplinkStatus & { name?: string };
  sessionStore?: NodeSessionStore;
  dispatchHttp?: DispatchHttp;
  wsServer?: WebSocketServer;
  connectTimeoutMs?: number;
  idleMs?: number;
  hostname?: string | string[];
  wsFactory?: (url: string) => WebSocketTransportInput | Promise<WebSocketTransportInput>;
  startServer?: boolean;
  maxConcurrentStreams?: number;
  rtc?: RtcPeerManager;
  linkFactory?: PeerLinkFactory;
  interfacesFn?: () => Record<string, RankableIfaceAddr[] | undefined>;
  refreshLocalInterfaces?: () => Record<string, RankableIfaceAddr[] | undefined>;
  hubHost?: string | null | (() => string | null);
  endpointBackoff?: PeerEndpointBackoff;
  dialLimiter?: DirectDialLimiter;
  onGatewaySession?: (
    session: GatewaySession,
    auth: { sid: string; uid: string; via: string; cid?: string }
  ) => boolean | undefined;
  onGatewaySessionClose?: (session: GatewaySession) => void;
  onBrowserSignal?: (msg: RtcSignalMessage, fromNodeId?: string) => void;
  ensureDcSession?: (peerNodeId: string, rtcSession: string) => void;
  onLinkInfo?: (info: {
    nodeId: string;
    reach: PeerReach;
    transport: PeerTransportKind | null;
    rttMs: number | null;
    dcBreaker?: RtcDialBreakerSnapshot;
  }) => void;
};

export type PeerLinkFactory = (
  peerNodeId: string,
  signal: AbortSignal
) => Promise<LinkSession | null>;

export type TransportWaiter = {
  kind: PeerTransportKind;
  resolve: (ok: boolean) => void;
};

export type LiveWaiter = {
  resolve: (session: LinkSession) => void;
};

/**
 * 直连失败的稳定分类码，与 `packages/api-client/src/auth/types.ts` 的 `DirectFailureCode`
 * 一一对应（网关不依赖 api-client，只能镜像）。前端按 `nodes.badge.failure.<code>` 翻译。
 */
export type DirectFailureCode =
  | 'timeout'
  | 'refused'
  | 'unreachable'
  | 'reset'
  | 'tls'
  | 'handshake'
  | 'revoked'
  | 'untrusted'
  | 'backoff'
  | 'no_endpoints'
  | 'ice_failed'
  | 'no_candidates'
  | 'dc_open_timeout'
  | 'dc_closed'
  | 'liveness_timeout'
  | 'signal_dropped'
  | 'signaling_state'
  | 'rtc_unavailable'
  | 'not_direct_capable'
  | 'breaker_cooling'
  | 'aborted'
  | 'other';

export type DirectFailureWsParams = { url?: string; seconds?: number };
export type DirectFailureDcParams = { until?: number };

export type DirectFailureView = {
  at: number;
  ws?: string | null;
  wsCode?: DirectFailureCode | null;
  wsParams?: DirectFailureWsParams | null;
  dc?: string | null;
  dcCode?: DirectFailureCode | null;
  dcParams?: DirectFailureDcParams | null;
};

export type PeerLinkDetail = {
  peerAddress: string | null;
  linkSinceAt: number | null;
  endpoints: string[];
  directFailure: DirectFailureView | null;
  dcBreaker: RtcDialBreakerSnapshot;
};

export type ParkedInbound = {
  session: LinkSession;
  transport: PeerTransportKind;
  initiatedBy: string;
  generation: number;
  at: number;
  timer: { clear: () => void } | null;
  remoteAddress: string | null;
};
