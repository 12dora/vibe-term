import { type TmexRoles, isStandaloneRoles } from '@tmex/shared';
import type { LinkSession } from '@tmex/shared/link';
import { type DispatchContext, requestDispatchContext } from './types';

export { isStandaloneRoles, requestDispatchContext };
export type { DispatchContext };

export const MESH_VIA_SELF = 'self';

export const X_TMEX_SET_SESSION = 'x-tmex-set-session';
export const X_TMEX_SESSION_RENEWED = 'x-tmex-session-renewed';
export const X_TMEX_CONNECTION = 'x-tmex-connection';

export const LOGIN_RATE_LIMIT = 10;
export const LOGIN_RATE_WINDOW_MS = 60_000;
export const LOGIN_CHALLENGE_TTL_MS = 60_000;
export const PASSKEY_REGISTER_TTL_MS = 60_000;
export const RTC_AUTHORIZE_TTL_MS = 120_000;
export const WS_SESSION_VERIFY_MS = 5 * 60 * 1000;
export const AUTH_401_BODY_LIMIT = 64 * 1024;
export const STREAM_FAILOVER_BACKOFF_MS = [0, 50, 100, 200, 400, 800, 1600] as const;
export const STREAM_FAILOVER_MAX_ATTEMPTS = STREAM_FAILOVER_BACKOFF_MS.length;
export const STREAM_FAILOVER_RESUME_WAIT_MS = 8_000;
export const HTTP_FAILOVER_MAX_ATTEMPTS = 4;
/** failover 期间泵队列上限；溢出关闭浏览器侧连接（1011 / STREAM_QUEUE_OVERFLOW_REASON），不静默丢帧。 */
export const STREAM_QUEUE_MAX_FRAMES = 256;
export const STREAM_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
export const STREAM_QUEUE_OVERFLOW_REASON = 'forward-queue-overflow';
export const MESH_WS_BACKPRESSURE_LIMIT_BYTES = 1_048_576;

export const MESH_WS_KIND = 'mesh-event';
export const MESH_FORWARD_WS_KIND = 'mesh-forward-ws';
export const MESH_REJECT_4401_KIND = 'mesh-reject-4401';
export const MESH_GATEWAY_WS_KIND = 'gateway-ws';
export const WS_CLOSE_LOGIN_REQUIRED = 4401;

export const MESH_FORWARD_CSP = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'";

export const MESH_ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'text/plain',
  'application/json',
  'application/x-ndjson',
  'application/pdf',
  'application/octet-stream',
]);

export type MeshRoles = TmexRoles;

export type HubTlsInfo = {
  caFingerprint: string | null;
  caPem: string | null;
};

export type HubTlsInfoProvider = () => HubTlsInfo | Promise<HubTlsInfo>;

export type PeerReachKind = 'lan' | 'wan' | 'relay' | null;

export type PeerTransportKind = 'ws-secure' | 'relay' | 'dc';

export type NodeEventStatus = 'online' | 'offline' | 'revoked';

export type NodeEventPayload = {
  nodeId: string;
  status: NodeEventStatus;
  reach?: PeerReachKind;
  transport?: PeerTransportKind | null;
  rttMs?: number | null;
  inventory?: string | null;
  version?: string | null;
  direct_capable?: boolean;
  name?: string;
};

export type PeerLinkProvider = {
  getLink(nodeId: string): Promise<LinkSession>;
  listReach(): Map<string, PeerReachKind>;
  listHubOnline?(): ReadonlySet<string>;
  transportOf?(nodeId: string): PeerTransportKind | null;
  rttOf?(nodeId: string): number | null;
  linkSinceAtOf?(nodeId: string): number | null;
  onNodeEvent(cb: (event: NodeEventPayload) => void): () => void;
};

export type HttpStreamOpen = {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  origin: string;
  auth: string | null;
};

export type OpenedWsStream = {
  send(bytes: Uint8Array): Promise<void>;
  onMessage(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: (info: { code?: number; reason?: string }) => void): void;
  close(code?: number, reason?: string): void;
  muxStreamId?: number;
};

export type StreamOpener = {
  openHttpStream(
    link: LinkSession,
    open: HttpStreamOpen,
    body: ReadableStream<Uint8Array> | null,
    signal: AbortSignal
  ): Promise<Response>;
  openWsStream(link: LinkSession, auth: string, cid?: string): Promise<OpenedWsStream>;
};

export type KeyLogHubAck = { ok: true; seq: bigint | number } | { ok: false; error: string };

export type KeyLogPublisher = {
  publish(record: { bytes: Uint8Array; sig: Uint8Array }): Promise<void> | void;
  publishAndAck?(record: { bytes: Uint8Array; sig: Uint8Array }): Promise<KeyLogHubAck>;
  queryHubHead?(): Promise<{ seq: bigint | number; hash: Uint8Array } | null>;
  queryKeyLogAt?(seq: bigint): Promise<{ bytes: Uint8Array; sig: Uint8Array } | null>;
};

export type DtlsFingerprint = {
  algorithm: string;
  value: string;
};

export type RtcAuthorizeBrowserInput = {
  rtcSession: string;
  uid: string;
  via: string;
  sid?: string;
  connectionId?: string;
  fpBrowser: DtlsFingerprint;
};

export type RtcAuthorizeBrowserResult = {
  nonce: Uint8Array;
  fpNode: DtlsFingerprint;
};

export type RtcFingerprintProvider = {
  authorizeBrowser(
    input: RtcAuthorizeBrowserInput
  ): RtcAuthorizeBrowserResult | null | Promise<RtcAuthorizeBrowserResult | null>;
};

export type RtcSignalMessage = {
  rtcSession: string;
  from: 'browser' | 'node';
  to: string;
  sdp?: string | null;
  candidate?: string | null;
};

export type RtcSignalOwner = {
  uid: string;
  sid: string;
};

export type RtcSignalRouter = {
  send(signal: RtcSignalMessage, owner?: RtcSignalOwner): void;
  subscribe(cb: (signal: RtcSignalMessage) => void): () => void;
};

export type CachedRtcConfig = {
  stun: string[];
  turn: unknown;
};

export type RtcConfigProvider = {
  getRtcConfig(): CachedRtcConfig | null;
};

export type MeshRtcDeps = {
  fingerprint?: RtcFingerprintProvider;
  signals?: RtcSignalRouter;
  config?: RtcConfigProvider;
};

export type ConnectionLookupResult =
  | { ok: true; connectionId: string }
  | { ok: false; code: 'NO_CONNECTION' | 'MULTIPLE_CONNECTIONS' };

export type ConnectionLookup = (input: {
  sid: string;
  via: string;
  connectionId?: string | null;
  cid?: string | null;
}) => ConnectionLookupResult;

export type MeshRequestContext = {
  via: string;
  auth?: string | null;
  clientIp?: string;
  selfRewrite?: string;
  sid?: string | null;
  uid?: string | null;
  renewedExpiresAt?: number;
  trustProxy?: boolean;
};

export type MeshRewritten = { rewritten: Request };

export type MeshHandleResult = Response | MeshRewritten | null | undefined;

const requestContext = new WeakMap<Request, MeshRequestContext>();

export function setMeshRequestContext(req: Request, ctx: MeshRequestContext): void {
  requestContext.set(req, ctx);
  const existing = requestDispatchContext.get(req);
  requestDispatchContext.set(req, {
    uid: ctx.uid ?? existing?.uid ?? null,
    viaNodeId: ctx.via,
    ...(ctx.renewedExpiresAt !== undefined
      ? { renewedExpiresAt: ctx.renewedExpiresAt }
      : existing?.renewedExpiresAt !== undefined
        ? { renewedExpiresAt: existing.renewedExpiresAt }
        : {}),
  });
}

export function getMeshRequestContext(req: Request): MeshRequestContext {
  const local = requestContext.get(req);
  const dispatch = requestDispatchContext.get(req);
  const via = dispatch?.viaNodeId ?? local?.via ?? MESH_VIA_SELF;
  return {
    via,
    auth: local?.auth,
    clientIp: local?.clientIp,
    selfRewrite: local?.selfRewrite,
    sid: local?.sid ?? null,
    uid: dispatch?.uid ?? local?.uid ?? null,
    renewedExpiresAt: dispatch?.renewedExpiresAt ?? local?.renewedExpiresAt,
    trustProxy: local?.trustProxy,
  };
}

export function isMeshRewritten(value: unknown): value is MeshRewritten {
  return (
    typeof value === 'object' &&
    value !== null &&
    'rewritten' in value &&
    (value as MeshRewritten).rewritten instanceof Request
  );
}

export type MeshUpgradeServer = {
  upgrade(req: Request, options?: { data?: unknown }): boolean;
};

export type MeshSocketKind =
  | typeof MESH_WS_KIND
  | typeof MESH_FORWARD_WS_KIND
  | typeof MESH_REJECT_4401_KIND
  | typeof MESH_GATEWAY_WS_KIND;

export type MeshSocketData = {
  kind: MeshSocketKind;
  nodeId?: string;
  auth?: string | null;
  token?: string;
  sid?: string | null;
  uid?: string | null;
  via?: string;
  cid?: string;
};

export type MeshServerWebSocket = {
  data: MeshSocketData;
  readyState?: number;
  send(data: Uint8Array | ArrayBuffer | ArrayBufferView | string): number | undefined;
  close(code?: number, reason?: string): void;
  getBufferedAmount?(): number;
};

export function parseSetSessionHeader(value: string): { sid: string; maxAgeSec: number } | null {
  const split = value.indexOf(';');
  if (split === -1) return null;
  const sid = value.slice(0, split).trim();
  const maxAgeSec = Number(value.slice(split + 1).trim());
  if (!Number.isFinite(maxAgeSec)) return null;
  return { sid, maxAgeSec };
}

export const LOGIN_LIMITER_MAX_KEYS = 10_000;
export const LOGIN_LIMITER_PRUNE_EVERY = 256;
export const CHALLENGE_RATE_LIMIT = 60;
/** 用户名最长 64 ASCII，user id 为 UUID；256 字节留余量，拒绝攻击者塞进 store / limiter 的超长 uid。 */
export const AUTH_UID_MAX_BYTES = 256;
