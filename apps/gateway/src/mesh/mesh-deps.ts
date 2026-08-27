import type { LinkSession } from '@tmex/shared/link';
import type { TmexRoles } from '../config';

export const MESH_VIA_SELF = 'self';

export const X_TMEX_SET_SESSION = 'x-tmex-set-session';
export const X_TMEX_SESSION_RENEWED = 'x-tmex-session-renewed';

export const LOGIN_RATE_LIMIT = 10;
export const LOGIN_RATE_WINDOW_MS = 60_000;
export const LOGIN_CHALLENGE_TTL_MS = 60_000;
export const PASSKEY_REGISTER_TTL_MS = 60_000;
export const RTC_AUTHORIZE_TTL_MS = 120_000;

export const MESH_WS_KIND = 'mesh-event';
export const MESH_FORWARD_WS_KIND = 'mesh-forward-ws';
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

export type PeerReachKind = 'lan' | 'relay' | null;

export type NodeEventStatus = 'online' | 'offline' | 'revoked';

export type NodeEventPayload = {
  nodeId: string;
  status: NodeEventStatus;
  reach?: PeerReachKind;
  inventory?: string | null;
};

export type PeerLinkProvider = {
  getLink(nodeId: string): Promise<LinkSession>;
  listReach(): Map<string, PeerReachKind>;
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
  send(bytes: Uint8Array): void;
  onMessage(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: (info: { code?: number; reason?: string }) => void): void;
  close(code?: number, reason?: string): void;
};

export type StreamOpener = {
  openHttpStream(
    link: LinkSession,
    open: HttpStreamOpen,
    body: ReadableStream<Uint8Array> | null,
    signal: AbortSignal
  ): Promise<Response>;
  openWsStream(link: LinkSession, auth: string): Promise<OpenedWsStream>;
};

export type KeyLogPublisher = {
  publish(record: { bytes: Uint8Array; sig: Uint8Array }): Promise<void> | void;
};

export type DtlsFingerprint = {
  algorithm: string;
  value: string;
};

export type RtcFingerprintProvider = {
  getFingerprint(): DtlsFingerprint | Promise<DtlsFingerprint>;
};

export type RtcSignalMessage = {
  rtcSession: string;
  from: 'browser' | 'node';
  to: string;
  sdp?: string | null;
  candidate?: string | null;
};

export type RtcSignalRouter = {
  send(signal: RtcSignalMessage): void;
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

export type MeshRequestContext = {
  via: string;
  auth?: string | null;
  clientIp?: string;
  selfRewrite?: string;
};

const requestContext = new WeakMap<Request, MeshRequestContext>();

export function setMeshRequestContext(req: Request, ctx: MeshRequestContext): void {
  requestContext.set(req, ctx);
}

export function getMeshRequestContext(req: Request): MeshRequestContext {
  return requestContext.get(req) ?? { via: MESH_VIA_SELF };
}

export function isStandaloneRoles(roles: MeshRoles): boolean {
  return !roles.hub && !roles.node;
}

export type MeshUpgradeServer = {
  upgrade(req: Request, options?: { data?: unknown }): boolean;
};

export type MeshSocketData = {
  kind: typeof MESH_WS_KIND | typeof MESH_FORWARD_WS_KIND;
  nodeId?: string;
  auth?: string | null;
  token?: string;
};

export type MeshServerWebSocket = {
  data: MeshSocketData;
  readyState?: number;
  send(data: Uint8Array | ArrayBuffer | ArrayBufferView | string): number | undefined;
  close(code?: number, reason?: string): void;
};
