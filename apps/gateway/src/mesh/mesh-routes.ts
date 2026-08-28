import { wsBorsh } from '@tmex/shared';
import { decodeCertificate, encodeBase64url } from '@tmex/shared/auth';
import { readJsonObjectBody } from '../api/http';
import { nodeSessionCookieName, parseCookies } from '../auth/cookies';
import type { NodeSessionStore } from '../auth/node-session-store';
import type { UserStore } from '../auth/user-store';
import type { PublicAuthNode } from './auth-routes';
import {
  type ConnectionLookup,
  MESH_REJECT_4401_KIND,
  MESH_VIA_SELF,
  MESH_WS_KIND,
  type MeshRoles,
  type MeshServerWebSocket,
  type MeshUpgradeServer,
  type PeerLinkProvider,
  type RtcConfigProvider,
  type RtcFingerprintProvider,
  type RtcSignalMessage,
  type RtcSignalRouter,
  WS_CLOSE_LOGIN_REQUIRED,
  X_TMEX_CONNECTION,
  getMeshRequestContext,
} from './mesh-deps';
import {
  type AuthenticateOk,
  type SessionMiddlewareDeps,
  authenticateRequest,
  jsonBody,
  jsonError,
  requireSession,
} from './session-middleware';
import type { UplinkStatus } from './types';

export type MeshNodeDto = {
  id: string;
  name: string;
  publicKey: string;
  online: boolean;
  reach: 'lan' | 'relay' | null;
  transport: 'ws-secure' | 'relay' | 'dc' | null;
  version: string | null;
  direct_capable: boolean;
  inventory: unknown;
  loggedIn: boolean;
  isHub: boolean;
};

export type MeshRoutesDeps = {
  roles: MeshRoles;
  nodeId: string;
  nodePk: Uint8Array;
  userStore: UserStore;
  nodeSessionStore: NodeSessionStore;
  peers: PeerLinkProvider;
  rtcFingerprint?: RtcFingerprintProvider;
  rtcSignals?: RtcSignalRouter;
  rtcConfig?: RtcConfigProvider;
  now?: () => number;
  registerSocket?: (ws: MeshServerWebSocket, auth: { sid: string; uid: string }) => void;
  connectionLookup?: ConnectionLookup;
  selfStatus?: () => UplinkStatus;
  listedNames?: () => ReadonlyArray<{ id: string; name: string }>;
  selfName?: () => string | null;
};

const STATUS_TO_U8: Record<string, number> = {
  online: wsBorsh.NODE_EVENT_STATUS_ONLINE,
  offline: wsBorsh.NODE_EVENT_STATUS_OFFLINE,
  revoked: wsBorsh.NODE_EVENT_STATUS_REVOKED,
};

export class MeshRoutes {
  private readonly sessionDeps: SessionMiddlewareDeps;
  private readonly meshSockets = new Set<MeshServerWebSocket>();
  private readonly unsubPeer: () => void;
  private unsubSignals: (() => void) | null = null;
  private seq = 0;

  constructor(private readonly deps: MeshRoutesDeps) {
    this.sessionDeps = {
      roles: deps.roles,
      nodeSessionStore: deps.nodeSessionStore,
      now: deps.now,
    };
    this.unsubPeer = deps.peers.onNodeEvent((event) => {
      this.broadcastNodeEvent(event);
    });
    if (deps.rtcSignals) {
      this.unsubSignals = deps.rtcSignals.subscribe((signal) => {
        this.broadcastRtcSignal(signal);
      });
    }
  }

  stop(): void {
    this.unsubPeer();
    this.unsubSignals?.();
    this.meshSockets.clear();
  }

  async handle(req: Request, server: MeshUpgradeServer): Promise<Response | null | undefined> {
    const path = new URL(req.url).pathname;
    if (path === '/api/mesh/nodes' && req.method === 'GET') {
      return requireSession(this.sessionDeps, (r) => this.handleNodes(r))(req);
    }
    if (path === '/api/mesh/rtc-config' && req.method === 'GET') {
      return requireSession(this.sessionDeps, () => this.handleRtcConfig())(req);
    }
    if (path === '/api/mesh/connection' && req.method === 'GET') {
      return requireSession(this.sessionDeps, (r, auth) => this.handleConnection(r, auth))(req);
    }
    if (path === '/api/rtc/authorize' && req.method === 'POST') {
      return requireSession(this.sessionDeps, (r, auth) => this.handleRtcAuthorize(r, auth))(req);
    }
    if (path === '/mesh/ws' && req.method === 'GET') {
      return this.handleMeshWsUpgrade(req, server);
    }
    if (path.startsWith('/api/mesh/')) {
      return jsonError('method_not_allowed', 405);
    }
    return null;
  }

  publicNodes(): PublicAuthNode[] {
    return this.collectNodes(null).map((n) => ({
      id: n.id,
      name: n.name,
      online: n.online,
    }));
  }

  handleMeshSocketOpen(ws: MeshServerWebSocket): void {
    this.meshSockets.add(ws);
    if (ws.data.sid && ws.data.uid) {
      this.deps.registerSocket?.(ws, { sid: ws.data.sid, uid: ws.data.uid });
    }
  }

  handleMeshSocketMessage(ws: MeshServerWebSocket, message: unknown): void {
    if (!this.deps.rtcSignals) return;
    const bytes = toBytes(message);
    if (!bytes) return;
    try {
      const env = wsBorsh.decodeEnvelope(bytes);
      if (env.kind !== wsBorsh.KIND_RTC_SIGNAL) return;
      const payload = wsBorsh.decodePayload(wsBorsh.schema.RtcSignalSchema, env.payload);
      if (payload.from === wsBorsh.RTC_SIGNAL_FROM_NODE) {
        return;
      }
      const uid = ws.data.uid;
      const sid = ws.data.sid;
      this.deps.rtcSignals.send(
        {
          rtcSession: payload.rtcSession,
          from: 'browser',
          to: payload.to,
          sdp: payload.sdp,
          candidate: payload.candidate,
        },
        uid && sid ? { uid, sid } : undefined
      );
    } catch {
      // drop malformed frames
    }
  }

  handleMeshSocketClose(ws: MeshServerWebSocket): void {
    this.meshSockets.delete(ws);
  }

  private handleNodes(req: Request): Response {
    return jsonBody({ nodes: this.collectNodes(req) });
  }

  forwardEnrollRedeemed(msg: {
    enrollPk: Uint8Array;
    certificate: Uint8Array;
    certSig: Uint8Array;
    nodeId: string;
    entrySid?: string;
  }): void {
    if (!msg.entrySid) return;
    try {
      wsBorsh.schema.assertEnrollRedeemedFields({
        enrollPk: msg.enrollPk,
        certificate: msg.certificate,
        certSig: msg.certSig,
        nodeId: msg.nodeId,
      });
    } catch {
      return;
    }
    const payload = wsBorsh.encodePayload(wsBorsh.schema.EnrollRedeemedSchema, {
      enrollPk: msg.enrollPk,
      certificate: msg.certificate,
      certSig: msg.certSig,
      nodeId: msg.nodeId,
    });
    const frame = wsBorsh.encodeEnvelope(wsBorsh.KIND_ENROLL_REDEEMED, payload, ++this.seq);
    for (const ws of this.meshSockets) {
      if (ws.data.sid !== msg.entrySid) continue;
      try {
        ws.send(frame);
      } catch {
        this.meshSockets.delete(ws);
      }
    }
  }

  private collectNodes(req: Request | null): MeshNodeDto[] {
    const cookies = req ? parseCookies(req.headers.get('cookie')) : new Map<string, string>();
    const reach = this.deps.peers.listReach();
    const hubOnline = this.deps.peers.listHubOnline?.() ?? new Set<string>();
    const certs = this.deps.userStore.listCerts().filter((c) => c.revokedLogSeq == null);
    const peers = this.deps.userStore.listPeers();
    const peerById = new Map(peers.map((p) => [p.nodeId, p]));
    const listedById = new Map(
      (this.deps.listedNames?.() ?? []).map((row) => [row.id, row.name] as const)
    );
    const registryById = new Map(
      this.deps.userStore.listNodes().map((row) => [row.id, row.name] as const)
    );
    const selfName = this.deps.selfName?.() ?? null;
    const ids = new Set<string>([this.deps.nodeId]);
    for (const cert of certs) ids.add(cert.nodeId);
    const hubNodeId = this.deps.roles.hub
      ? this.deps.nodeId
      : (this.deps.userStore.getHubMeta()?.nodeId ?? null);

    const nodes: MeshNodeDto[] = [];
    for (const id of ids) {
      const cert = certs.find((c) => c.nodeId === id);
      if (id !== this.deps.nodeId && !cert) continue;
      const peer = peerById.get(id);
      let publicKey = this.deps.nodePk;
      if (id !== this.deps.nodeId && cert) {
        try {
          publicKey = decodeCertificate(cert.certificateBytes).ed_pk;
        } catch {
          continue;
        }
      }
      const isSelf = id === this.deps.nodeId;
      const r = reach.get(id) ?? null;
      const online = isSelf ? true : hubOnline.has(id) || r === 'lan' || r === 'relay';
      const loggedIn = isSelf
        ? cookies.has(nodeSessionCookieName(MESH_VIA_SELF))
        : cookies.has(nodeSessionCookieName(id));
      const listedName = listedById.get(id);
      const registryName = registryById.get(id);
      let inventory: unknown = null;
      if (peer?.inventoryJson) {
        try {
          inventory = JSON.parse(peer.inventoryJson);
        } catch {
          inventory = peer.inventoryJson;
        }
      }
      let version = versionFromInventory(inventory);
      let directCapable = peer?.directCapable ?? false;
      if (isSelf) {
        const self = this.deps.selfStatus?.();
        if (self) {
          inventory = self.inventory ?? inventory;
          version = self.version || versionFromInventory(inventory);
          directCapable = self.direct_capable;
        }
      }
      nodes.push({
        id,
        name: pickMeshNodeName({
          id,
          isSelf,
          listedName,
          registryName,
          peerName: peer?.name,
          selfName: isSelf ? selfName : null,
        }),
        publicKey: encodeBase64url(publicKey),
        online,
        reach: r,
        transport: isSelf ? null : (this.deps.peers.transportOf?.(id) ?? null),
        version,
        direct_capable: directCapable,
        inventory,
        loggedIn,
        isHub: hubNodeId != null && id === hubNodeId,
      });
    }
    return nodes;
  }

  private handleRtcConfig(): Response {
    const cfg = this.deps.rtcConfig?.getRtcConfig() ?? { stun: [], turn: null };
    return jsonBody({ stun: cfg.stun, turn: cfg.turn ?? null });
  }

  private handleConnection(req: Request, auth: AuthenticateOk): Response {
    if (!auth.sid) {
      return jsonError('UNAUTHORIZED', 401);
    }
    const via = getMeshRequestContext(req).via || MESH_VIA_SELF;
    const url = new URL(req.url);
    const cid = url.searchParams.get('cid')?.trim() || null;
    const header = req.headers.get(X_TMEX_CONNECTION)?.trim() || null;
    const resolved = this.deps.connectionLookup?.({
      sid: auth.sid,
      via,
      cid,
      connectionId: cid ? null : header,
    });
    if (!resolved) {
      return jsonError('NO_CONNECTION', 404);
    }
    if (!resolved.ok) {
      const status = resolved.code === 'MULTIPLE_CONNECTIONS' ? 409 : 404;
      return jsonError(resolved.code, status, {
        hint: 'open Gateway WS with ?cid=<tab-nonce> then GET /api/mesh/connection?cid=',
      });
    }
    return jsonBody({ connectionId: resolved.connectionId });
  }

  private async handleRtcAuthorize(req: Request, auth: AuthenticateOk): Promise<Response> {
    if (!auth.userId) {
      return jsonError('UNAUTHORIZED', 401);
    }
    if (!this.deps.rtcFingerprint) {
      return jsonError('DIRECT_UNAVAILABLE', 503);
    }
    const body = await readJsonObjectBody(req);
    const rtcSession = typeof body?.rtcSession === 'string' ? body.rtcSession : '';
    const fp = body?.fp_browser;
    if (!rtcSession || typeof fp !== 'object' || fp === null) {
      return jsonError('MALFORMED', 400);
    }
    const fpBrowser = fp as { algorithm?: unknown; value?: unknown };
    if (typeof fpBrowser.algorithm !== 'string' || typeof fpBrowser.value !== 'string') {
      return jsonError('MALFORMED', 400);
    }
    const via = getMeshRequestContext(req).via || MESH_VIA_SELF;
    if (!auth.sid) {
      return jsonError('UNAUTHORIZED', 401);
    }
    const bodyConnectionId = typeof body?.connectionId === 'string' ? body.connectionId.trim() : '';
    const headerConnectionId = req.headers.get(X_TMEX_CONNECTION)?.trim() || '';
    const requestedConnectionId = bodyConnectionId || headerConnectionId || null;
    const resolved = this.deps.connectionLookup?.({
      sid: auth.sid,
      via,
      connectionId: requestedConnectionId,
    });
    if (resolved && !resolved.ok) {
      const status = resolved.code === 'MULTIPLE_CONNECTIONS' ? 409 : 404;
      return jsonError(resolved.code, status, {
        hint: 'send connectionId from GET /api/mesh/connection or x-tmex-connection',
      });
    }
    const granted = await this.deps.rtcFingerprint.authorizeBrowser({
      rtcSession,
      uid: auth.userId,
      via,
      sid: auth.sid,
      ...(resolved?.ok ? { connectionId: resolved.connectionId } : {}),
      fpBrowser: { algorithm: fpBrowser.algorithm, value: fpBrowser.value },
    });
    if (!granted) {
      return jsonError('DIRECT_UNAVAILABLE', 503);
    }
    return jsonBody({
      nonce: encodeBase64url(granted.nonce),
      fp_node: granted.fpNode,
    });
  }

  private handleMeshWsUpgrade(req: Request, server: MeshUpgradeServer): Response | undefined {
    const result = authenticateRequest(req, this.sessionDeps);
    if (!result.ok || !result.sid || !result.userId) {
      const upgraded = server.upgrade(req, {
        data: { kind: MESH_REJECT_4401_KIND },
      });
      if (!upgraded) {
        return jsonError('UNAUTHORIZED', 401);
      }
      return undefined;
    }
    const ok = server.upgrade(req, {
      data: {
        kind: MESH_WS_KIND,
        sid: result.sid,
        uid: result.userId,
        via: MESH_VIA_SELF,
      },
    });
    if (!ok) {
      return jsonError('upgrade_failed', 500);
    }
    return undefined;
  }

  private broadcastNodeEvent(event: {
    nodeId: string;
    status: string;
    reach?: 'lan' | 'relay' | null;
    inventory?: string | null;
    version?: string | null;
    direct_capable?: boolean;
    name?: string;
  }): void {
    const payload = wsBorsh.encodeNodeEvent({
      nodeId: event.nodeId,
      status: STATUS_TO_U8[event.status] ?? wsBorsh.NODE_EVENT_STATUS_OFFLINE,
      reach: event.reach ?? null,
      inventory: event.inventory ?? null,
      version: event.version ?? null,
      directCapable: event.direct_capable ?? null,
      name: event.name ?? null,
    });
    const frame = wsBorsh.encodeEnvelope(wsBorsh.KIND_NODE_EVENT, payload, ++this.seq);
    this.broadcast(frame);
  }

  private broadcastRtcSignal(signal: RtcSignalMessage): void {
    const payload = wsBorsh.encodePayload(wsBorsh.schema.RtcSignalSchema, {
      rtcSession: signal.rtcSession,
      from: signal.from === 'node' ? wsBorsh.RTC_SIGNAL_FROM_NODE : wsBorsh.RTC_SIGNAL_FROM_BROWSER,
      to: signal.to,
      sdp: signal.sdp ?? null,
      candidate: signal.candidate ?? null,
    });
    const frame = wsBorsh.encodeEnvelope(wsBorsh.KIND_RTC_SIGNAL, payload, ++this.seq);
    this.broadcast(frame);
  }

  private broadcast(frame: Uint8Array): void {
    for (const ws of this.meshSockets) {
      try {
        ws.send(frame);
      } catch {
        this.meshSockets.delete(ws);
      }
    }
  }
}

function toBytes(message: unknown): Uint8Array | null {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  return null;
}

function usableMeshName(name: string | null | undefined, nodeId: string): string | null {
  const trimmed = name?.trim() ?? '';
  if (!trimmed || trimmed === nodeId || trimmed === 'self') return null;
  return trimmed;
}

function pickMeshNodeName(input: {
  id: string;
  isSelf: boolean;
  listedName?: string | null;
  registryName?: string | null;
  peerName?: string | null;
  selfName?: string | null;
}): string {
  return (
    usableMeshName(input.listedName, input.id) ??
    usableMeshName(input.registryName, input.id) ??
    usableMeshName(input.peerName, input.id) ??
    (input.isSelf ? usableMeshName(input.selfName, input.id) : null) ??
    (input.isSelf ? input.selfName?.trim() || 'self' : input.id)
  );
}

function versionFromInventory(inventory: unknown): string | null {
  if (inventory && typeof inventory === 'object' && inventory !== null && 'version' in inventory) {
    const value = (inventory as { version: unknown }).version;
    if (value == null) return null;
    return String(value);
  }
  return null;
}
