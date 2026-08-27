import { wsBorsh } from '@tmex/shared';
import { decodeCertificate, encodeBase64url } from '@tmex/shared/auth';
import { readJsonObjectBody } from '../api/http';
import type { ChallengeStore } from '../auth/challenge-store';
import { nodeSessionCookieName, parseCookies } from '../auth/cookies';
import type { NodeSessionStore } from '../auth/node-session-store';
import type { UserStore } from '../auth/user-store';
import {
  MESH_VIA_SELF,
  MESH_WS_KIND,
  type MeshRoles,
  type MeshServerWebSocket,
  type MeshUpgradeServer,
  type PeerLinkProvider,
  RTC_AUTHORIZE_TTL_MS,
  type RtcConfigProvider,
  type RtcFingerprintProvider,
  type RtcSignalMessage,
  type RtcSignalRouter,
  getMeshRequestContext,
} from './mesh-deps';
import {
  type SessionMiddlewareDeps,
  authenticateRequest,
  jsonBody,
  jsonError,
  requireSession,
} from './session-middleware';

export type MeshNodeDto = {
  id: string;
  name: string;
  publicKey: string;
  online: boolean;
  reach: 'lan' | 'relay' | null;
  version: string | null;
  direct_capable: boolean;
  inventory: unknown;
  loggedIn: boolean;
};

export type MeshRoutesDeps = {
  roles: MeshRoles;
  nodeId: string;
  nodePk: Uint8Array;
  userStore: UserStore;
  challengeStore: ChallengeStore;
  nodeSessionStore: NodeSessionStore;
  peers: PeerLinkProvider;
  rtcFingerprint?: RtcFingerprintProvider;
  rtcSignals?: RtcSignalRouter;
  rtcConfig?: RtcConfigProvider;
  now?: () => number;
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
      return this.handleNodes(req);
    }
    if (path === '/api/mesh/rtc-config' && req.method === 'GET') {
      return this.handleRtcConfig();
    }
    if (path === '/api/rtc/authorize' && req.method === 'POST') {
      return requireSession(this.sessionDeps, (r, auth) => this.handleRtcAuthorize(r, auth.userId))(
        req
      );
    }
    if (path === '/mesh/ws' && req.method === 'GET') {
      return this.handleMeshWsUpgrade(req, server);
    }
    if (path.startsWith('/api/mesh/')) {
      return jsonError('method_not_allowed', 405);
    }
    return null;
  }

  handleMeshSocketOpen(ws: MeshServerWebSocket): void {
    this.meshSockets.add(ws);
  }

  handleMeshSocketMessage(ws: MeshServerWebSocket, message: unknown): void {
    if (!this.deps.rtcSignals) return;
    const bytes = toBytes(message);
    if (!bytes) return;
    try {
      const env = wsBorsh.decodeEnvelope(bytes);
      if (env.kind !== wsBorsh.KIND_RTC_SIGNAL) return;
      const payload = wsBorsh.decodePayload(wsBorsh.schema.RtcSignalSchema, env.payload);
      this.deps.rtcSignals.send({
        rtcSession: payload.rtcSession,
        from: payload.from === wsBorsh.RTC_SIGNAL_FROM_NODE ? 'node' : 'browser',
        to: payload.to,
        sdp: payload.sdp,
        candidate: payload.candidate,
      });
    } catch {
      // drop malformed frames
    }
    void ws;
  }

  handleMeshSocketClose(ws: MeshServerWebSocket): void {
    this.meshSockets.delete(ws);
  }

  private handleNodes(req: Request): Response {
    const cookies = parseCookies(req.headers.get('cookie'));
    const reach = this.deps.peers.listReach();
    const certs = this.deps.userStore.listCerts().filter((c) => c.revokedLogSeq == null);
    const peers = this.deps.userStore.listPeers();
    const peerById = new Map(peers.map((p) => [p.nodeId, p]));
    const ids = new Set<string>([this.deps.nodeId]);
    for (const cert of certs) ids.add(cert.nodeId);

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
      const r = isSelf ? (reach.get(id) ?? null) : (reach.get(id) ?? null);
      const loggedIn = isSelf
        ? cookies.has(nodeSessionCookieName(MESH_VIA_SELF))
        : cookies.has(nodeSessionCookieName(id));
      let inventory: unknown = null;
      if (peer?.inventoryJson) {
        try {
          inventory = JSON.parse(peer.inventoryJson);
        } catch {
          inventory = peer.inventoryJson;
        }
      }
      const version =
        inventory && typeof inventory === 'object' && inventory !== null && 'version' in inventory
          ? String((inventory as { version: unknown }).version)
          : null;
      nodes.push({
        id,
        name: peer?.name ?? (isSelf ? 'self' : id),
        publicKey: encodeBase64url(publicKey),
        online: isSelf ? true : r === 'lan' || r === 'relay',
        reach: r,
        version,
        direct_capable: peer?.directCapable ?? false,
        inventory,
        loggedIn,
      });
    }
    return jsonBody({ nodes });
  }

  private handleRtcConfig(): Response {
    const cfg = this.deps.rtcConfig?.getRtcConfig() ?? { stun: [], turn: null };
    return jsonBody({ stun: cfg.stun, turn: cfg.turn ?? null });
  }

  private async handleRtcAuthorize(req: Request, userId: string | null): Promise<Response> {
    if (!userId) {
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
    const created = this.deps.challengeStore.create({
      uid: userId,
      entryNodeId: getMeshRequestContext(req).via || MESH_VIA_SELF,
      kind: 'rtc-authorize',
      ttlMs: RTC_AUTHORIZE_TTL_MS,
      payload: { rtcSession, fp_browser: fpBrowser },
    });
    const fpNode = await this.deps.rtcFingerprint.getFingerprint();
    return jsonBody({
      nonce: encodeBase64url(created.nonce),
      fp_node: fpNode,
    });
  }

  private handleMeshWsUpgrade(req: Request, server: MeshUpgradeServer): Response | undefined {
    const result = authenticateRequest(req, this.sessionDeps);
    if (!result.ok) {
      return jsonError('UNAUTHORIZED', 401);
    }
    const ok = server.upgrade(req, { data: { kind: MESH_WS_KIND } });
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
  }): void {
    const payload = wsBorsh.encodePayload(wsBorsh.schema.NodeEventSchema, {
      nodeId: event.nodeId,
      status: STATUS_TO_U8[event.status] ?? wsBorsh.NODE_EVENT_STATUS_OFFLINE,
      reach: event.reach ?? null,
      inventory: event.inventory ?? null,
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
