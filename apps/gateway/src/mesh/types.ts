import type { LinkSession, LinkStream } from '@tmex/shared/link';
import type { UserStore } from '../auth/user-store';

export type MeshNodeId = string;

/** Hosts `PeerServer` binds. Default is dual-stack. */
export type PeerBindHost = string | string[];
export const DEFAULT_PEER_BIND_HOSTS: readonly string[] = ['::', '0.0.0.0'];

export type MeshIdentity = {
  nodeId: MeshNodeId;
  edSecretKey: Uint8Array;
};

export type UplinkStatus = {
  version: string;
  tmux: boolean;
  direct_capable: boolean;
  inventory: unknown;
  endpoints: unknown;
};

export type KeyLogApplier = {
  head(userId: string, signal?: AbortSignal): Promise<{ seq: bigint; hash: Uint8Array }>;
  applyMany(
    userId: string,
    records: { bytes: Uint8Array; sig: Uint8Array }[],
    signal?: AbortSignal
  ): Promise<{ applied: number; error?: string }>;
  list?(
    userId: string,
    fromSeq: bigint,
    signal?: AbortSignal,
    limit?: number
  ): Promise<{ seq: bigint; bytes: Uint8Array; sig: Uint8Array }[]>;
};

export type KeyLogForkEvent = {
  userId: string;
  local: { seq: bigint; hash: Uint8Array };
  remote: { seq: bigint; hash: Uint8Array };
};

export type MeshScheduler = {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  interval(fn: () => void, ms: number): { clear: () => void };
};

export type UplinkState = 'offline' | 'connecting' | 'online';

/**
 * Path 1 data plane is a real WebRTC DataChannel in Phase 3 (B3-1).
 * Until then the peer-port WebSocket carries `SecureChannelLink` (`ws-secure`)
 * with the same handshake (`eph_x25519_pk`) and transcript `path: 'relay'` as
 * hub relay. `'dc'` is reserved for the DataChannel binding that includes
 * DTLS fingerprints — do not use it on the interim WS path.
 */
export type PeerTransportKind = 'ws-secure' | 'relay' | 'dc';

/** Phase 3 extension point — B3-1 fills this with a DataChannel-backed LinkSession. */
export type DataChannelLinkSlot = {
  readonly transport: 'dc';
  session: LinkSession | null;
};

export type PeerReach = 'lan' | 'wan' | 'relay' | null;

export type EstablishedPeerLink = {
  session: LinkSession;
  peerNodeId: MeshNodeId;
  transport: PeerTransportKind;
};

export type DispatchContext = {
  uid: string | null;
  viaNodeId: string;
  renewedExpiresAt?: number;
};

/** Trusted mesh routing context for a Request built by `acceptHttpStream`. */
export const requestDispatchContext = new WeakMap<Request, DispatchContext>();

export type DispatchHttp = (request: Request, ctx: DispatchContext) => Promise<Response>;

export class NodeUnreachableError extends Error {
  readonly code = 'NODE_UNREACHABLE';
  readonly nodeId: string;

  constructor(nodeId: string, message?: string) {
    super(message ?? `node ${nodeId} is unreachable`);
    this.name = 'NodeUnreachableError';
    this.nodeId = nodeId;
  }
}

export class PeerHandshakeError extends Error {
  readonly code: 'unknown' | 'revoked' | 'bad_signature' | 'timeout' | 'protocol';

  constructor(code: PeerHandshakeError['code'], message: string) {
    super(message);
    this.name = 'PeerHandshakeError';
    this.code = code;
  }
}

export type LookupPeerCert = Pick<UserStore, 'getCert'>;

export type RelayOpenPayload = {
  to: string;
  from?: string;
};

export type HttpStreamOpenPayload = {
  type?: 'http';
  method: string;
  path: string;
  query?: string;
  headers?: Record<string, string>;
  origin: string;
  auth?: string | null;
};

export type WsStreamOpenPayload = {
  type?: 'ws';
  auth: string;
  cid?: string;
  connectionId?: string;
};

export type InboundRelayHandler = (stream: LinkStream, fromNodeId: string) => void;
