import type { LinkSession, LinkStream } from '@tmex/shared/link';
import type { UserStore } from '../auth/user-store';

export type MeshNodeId = string;

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
  head(userId: string): Promise<{ seq: bigint; hash: Uint8Array }>;
  applyMany(
    userId: string,
    records: { bytes: Uint8Array; sig: Uint8Array }[]
  ): Promise<{ applied: number; error?: string }>;
  list?(
    userId: string,
    fromSeq: bigint
  ): Promise<{ seq: bigint; bytes: Uint8Array; sig: Uint8Array }[]>;
};

export type MeshScheduler = {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  interval(fn: () => void, ms: number): { clear: () => void };
};

export type UplinkState = 'offline' | 'connecting' | 'online';

/**
 * Path 1 is WebRTC DataChannel in Phase 3 (B3-1). Until then the peer-port
 * signaling WebSocket carries the mux directly (`ws-direct`).
 * `dc` is reserved so DataChannelLink can drop in without a wire-format change.
 */
export type PeerTransportKind = 'ws-direct' | 'relay' | 'dc';

/** Phase 3 extension point — B3-1 fills this with a DataChannel-backed LinkSession. */
export type DataChannelLinkSlot = {
  readonly transport: 'dc';
  session: LinkSession | null;
};

export type PeerReach = 'lan' | 'relay' | null;

export type EstablishedPeerLink = {
  session: LinkSession;
  peerNodeId: MeshNodeId;
  transport: PeerTransportKind;
};

export type DispatchHttp = (request: Request, ctx: { uid: string }) => Promise<Response>;

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
};

export type InboundRelayHandler = (stream: LinkStream, fromNodeId: string) => void;
