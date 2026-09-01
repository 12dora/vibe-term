import { wsBorsh } from '@tmex/shared';
import { encodeBase64url } from '@tmex/shared/auth';
import { readJsonObjectBody } from '../api/http';
import { parseCookies } from '../auth/cookies';
import type { MeshHubStore } from '../auth/mesh-hub-store';
import { pickWriterHub } from '../auth/mesh-hub-store';
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
  type MeshNodeDto,
  type MeshNodeLinkDetail,
  projectMeshListNode,
} from './node-list-projection';
import {
  type AuthenticateOk,
  type SessionMiddlewareDeps,
  authenticateRequest,
  jsonBody,
  jsonError,
  requireSession,
} from './session-middleware';
import type { UplinkStatus } from './types';
import type { AttachedHub, UplinkCandidate } from './uplink-pool';

export type { MeshNodeDto };

export type MeshRoutesDeps = {
  roles: MeshRoles;
  nodeId: string;
  nodePk: Uint8Array;
  userStore: UserStore;
  nodeSessionStore: NodeSessionStore;
  peers: PeerLinkProvider & {
    linkDetailOf?(nodeId: string): MeshNodeLinkDetail | null;
  };
  rtcFingerprint?: RtcFingerprintProvider;
  rtcSignals?: RtcSignalRouter;
  rtcConfig?: RtcConfigProvider;
  now?: () => number;
  registerSocket?: (ws: MeshServerWebSocket, auth: { sid: string; uid: string }) => void;
  connectionLookup?: ConnectionLookup;
  selfStatus?: () => UplinkStatus;
  listedNames?: () => ReadonlyArray<{ id: string; name: string }>;
  selfName?: () => string | null;
  hubStore?: MeshHubStore;
  attachedHub?: () => AttachedHub | null;
  hubCandidates?: () => Array<string | UplinkCandidate>;
  forwardAuthorizedHttp?: (
    req: Request,
    input: { nodeId: string; method: string; path: string; query?: string; body?: unknown }
  ) => Promise<Response>;
};

const STATUS_TO_U8: Record<string, number> = {
  online: wsBorsh.NODE_EVENT_STATUS_ONLINE,
  offline: wsBorsh.NODE_EVENT_STATUS_OFFLINE,
  revoked: wsBorsh.NODE_EVENT_STATUS_REVOKED,
};

function serializeHubCandidate(entry: string | UplinkCandidate): {
  publicUrl: string;
  lastError: string | null;
  lastAttemptAt: number | null;
} {
  if (typeof entry === 'string') {
    return { publicUrl: entry, lastError: null, lastAttemptAt: null };
  }
  return {
    publicUrl: entry.publicUrl,
    lastError: entry.lastError ?? null,
    lastAttemptAt: entry.lastAttemptAt ?? null,
  };
}

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
    if (path === '/api/mesh/hubs' && req.method === 'GET') {
      return requireSession(this.sessionDeps, () => this.handleHubs())(req);
    }
    if (path === '/api/mesh/upgrade/latest' && req.method === 'GET') {
      return requireSession(this.sessionDeps, () => this.handleUpgradeLatest())(req);
    }
    const upgradeRoute = this.matchUpgradeNodeRoute(req, path);
    if (upgradeRoute) return upgradeRoute;
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
      if (payload.from === wsBorsh.RTC_SIGNAL_FROM_NODE) return;
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
    } catch {}
  }

  handleMeshSocketClose(ws: MeshServerWebSocket): void {
    this.meshSockets.delete(ws);
  }

  private handleNodes(req: Request): Response {
    return jsonBody({ nodes: this.collectNodes(req) });
  }

  private handleHubs(): Response {
    const store = this.deps.hubStore;
    const rows = store?.list() ?? [];
    const writerHubId = pickWriterHub(rows);
    const attached = this.deps.attachedHub?.() ?? null;
    const rawCandidates = this.deps.hubCandidates?.() ?? rows.map((row) => row.publicUrl);
    return jsonBody({
      hubs: rows.map((row) => ({
        nodeId: row.hubNodeId,
        publicUrl: row.publicUrl,
        ...(row.name ? { name: row.name } : {}),
        mode: row.mode,
        priority: row.priority,
        writerEpoch: row.writerEpoch,
        caFingerprint: row.caFingerprint,
        online: row.online,
        lastSeenAt: row.lastSeenAt,
      })),
      attached,
      writerHubId,
      candidates: rawCandidates.map(serializeHubCandidate),
    });
  }

  private matchUpgradeNodeRoute(req: Request, path: string): Promise<Response> | undefined {
    const match = path.match(/^\/api\/mesh\/nodes\/([^/]+)\/upgrade$/);
    if (!match) return undefined;
    const nodeId = decodeURIComponent(match[1] ?? '');
    if (req.method === 'POST') {
      return requireSession(this.sessionDeps, (r) => this.handleUpgradeStart(r, nodeId))(req);
    }
    if (req.method === 'GET') {
      return requireSession(this.sessionDeps, (r) => this.handleUpgradeStatus(r, nodeId))(req);
    }
    return undefined;
  }

  private handleUpgradeLatest(): Promise<Response> {
    return import('../system/upgrade-service').then((mod) => mod.handleMeshUpgradeLatest());
  }

  private async handleUpgradeStart(req: Request, nodeId: string): Promise<Response> {
    const { handleMeshNodeUpgradeStart } = await import('../system/upgrade-service');
    return handleMeshNodeUpgradeStart({
      req,
      nodeId,
      localNodeId: this.deps.nodeId,
      userStore: this.deps.userStore,
      forward: {
        forwardAuthorizedHttp: (r, input) => this.forwardAuthorized(r, input),
      },
    });
  }

  private async handleUpgradeStatus(req: Request, nodeId: string): Promise<Response> {
    const { handleMeshNodeUpgradeStatus } = await import('../system/upgrade-service');
    return handleMeshNodeUpgradeStatus({
      req,
      nodeId,
      localNodeId: this.deps.nodeId,
      userStore: this.deps.userStore,
      forward: {
        forwardAuthorizedHttp: (r, input) => this.forwardAuthorized(r, input),
      },
    });
  }

  private forwardAuthorized(
    req: Request,
    input: { nodeId: string; method: string; path: string; query?: string; body?: unknown }
  ): Promise<Response> {
    if (!this.deps.forwardAuthorizedHttp) {
      return Promise.resolve(jsonError('NODE_UNREACHABLE', 503, { nodeId: input.nodeId }));
    }
    return this.deps.forwardAuthorizedHttp(req, input);
  }

  forwardEnrollRedeemed(msg: {
    enrollPk: Uint8Array;
    certificate: Uint8Array;
    certSig: Uint8Array;
    nodeId: string;
    entrySid?: string;
  }): void {
    if (!msg.entrySid) return;
    const fields = {
      enrollPk: msg.enrollPk,
      certificate: msg.certificate,
      certSig: msg.certSig,
      nodeId: msg.nodeId,
    };
    try {
      wsBorsh.schema.assertEnrollRedeemedFields(fields);
    } catch {
      return;
    }
    const frame = wsBorsh.encodeEnvelope(
      wsBorsh.KIND_ENROLL_REDEEMED,
      wsBorsh.encodePayload(wsBorsh.schema.EnrollRedeemedSchema, fields),
      ++this.seq
    );
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
    const certById = new Map(certs.map((c) => [c.nodeId, c]));
    const peerById = new Map(this.deps.userStore.listPeers().map((p) => [p.nodeId, p]));
    const listedById = new Map((this.deps.listedNames?.() ?? []).map((row) => [row.id, row.name]));
    const registryById = new Map(this.deps.userStore.listNodes().map((row) => [row.id, row.name]));
    const selfName = this.deps.selfName?.() ?? null;
    const self = this.deps.selfStatus?.();
    const storedHubs = this.deps.hubStore?.list() ?? [];
    const hubIds = new Set(storedHubs.map((row) => row.hubNodeId));
    const hubModeById = new Map(storedHubs.map((row) => [row.hubNodeId, row.mode] as const));
    const hubNodeId = this.deps.roles.hub
      ? this.deps.nodeId
      : (pickWriterHub(storedHubs) ?? this.deps.userStore.getHubMeta()?.nodeId ?? null);
    if (hubNodeId) hubIds.add(hubNodeId);
    return [...new Set([this.deps.nodeId, ...certs.map((c) => c.nodeId)])]
      .map((id) =>
        projectMeshListNode(
          id,
          this.deps.nodeId,
          this.deps.nodePk,
          cookies,
          reach,
          hubOnline,
          certById,
          peerById,
          listedById,
          registryById,
          selfName,
          self,
          hubNodeId,
          (nid) => this.deps.peers.transportOf?.(nid) ?? null,
          (nid) => this.deps.peers.rttOf?.(nid) ?? null,
          (nid) => this.deps.peers.linkDetailOf?.(nid) ?? null,
          hubIds,
          (nid) => hubModeById.get(nid)
        )
      )
      .filter((n) => n != null);
  }

  private handleRtcConfig(): Response {
    const cfg = this.deps.rtcConfig?.getRtcConfig() ?? { stun: [], turn: null };
    return jsonBody({ stun: cfg.stun, turn: cfg.turn ?? null });
  }

  private handleConnection(req: Request, auth: AuthenticateOk): Response {
    if (!auth.sid) return jsonError('UNAUTHORIZED', 401);
    const via = getMeshRequestContext(req).via || MESH_VIA_SELF;
    const cid = new URL(req.url).searchParams.get('cid')?.trim() || null;
    const resolved = this.deps.connectionLookup?.({
      sid: auth.sid,
      via,
      cid,
      connectionId: cid ? null : req.headers.get(X_TMEX_CONNECTION)?.trim() || null,
    });
    if (!resolved) return jsonError('NO_CONNECTION', 404);
    if (!resolved.ok) {
      return jsonError(resolved.code, resolved.code === 'MULTIPLE_CONNECTIONS' ? 409 : 404, {
        hint: 'open Gateway WS with ?cid=<tab-nonce> then GET /api/mesh/connection?cid=',
      });
    }
    return jsonBody({ connectionId: resolved.connectionId });
  }

  private async handleRtcAuthorize(req: Request, auth: AuthenticateOk): Promise<Response> {
    if (!auth.userId) return jsonError('UNAUTHORIZED', 401);
    if (!this.deps.rtcFingerprint) return jsonError('DIRECT_UNAVAILABLE', 503);
    const parsed = rtcAuthFields(await readJsonObjectBody(req), req);
    if (!parsed) return jsonError('MALFORMED', 400);
    if (!auth.sid) return jsonError('UNAUTHORIZED', 401);
    const via = getMeshRequestContext(req).via || MESH_VIA_SELF;
    const resolved = this.deps.connectionLookup?.({
      sid: auth.sid,
      via,
      connectionId: parsed.connectionId,
    });
    const fail = lookupFail(
      resolved,
      'send connectionId from GET /api/mesh/connection or x-tmex-connection'
    );
    if (fail) return fail;
    const granted = await this.deps.rtcFingerprint.authorizeBrowser({
      rtcSession: parsed.rtcSession,
      uid: auth.userId,
      via,
      sid: auth.sid,
      ...(resolved?.ok ? { connectionId: resolved.connectionId } : {}),
      fpBrowser: parsed.fp,
    });
    if (!granted) return jsonError('DIRECT_UNAVAILABLE', 503);
    return jsonBody({ nonce: encodeBase64url(granted.nonce), fp_node: granted.fpNode });
  }

  private handleMeshWsUpgrade(req: Request, server: MeshUpgradeServer): Response | undefined {
    const result = authenticateRequest(req, this.sessionDeps);
    if (!result.ok || !result.sid || !result.userId) {
      const upgraded = server.upgrade(req, { data: { kind: MESH_REJECT_4401_KIND } });
      return upgraded ? undefined : jsonError('UNAUTHORIZED', 401);
    }
    const ok = server.upgrade(req, {
      data: { kind: MESH_WS_KIND, sid: result.sid, uid: result.userId, via: MESH_VIA_SELF },
    });
    return ok ? undefined : jsonError('upgrade_failed', 500);
  }

  private broadcastNodeEvent(event: {
    nodeId: string;
    status: string;
    reach?: 'lan' | 'wan' | 'relay' | null;
    transport?: 'ws-secure' | 'relay' | 'dc' | null;
    rttMs?: number | null;
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
      transport: event.transport ?? null,
      rttMs: event.rttMs ?? null,
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

function lookupFail(
  resolved: { ok: true; connectionId: string } | { ok: false; code: string } | undefined,
  hint: string
): Response | null {
  return resolved && !resolved.ok
    ? jsonError(resolved.code, resolved.code === 'MULTIPLE_CONNECTIONS' ? 409 : 404, { hint })
    : null;
}

function rtcAuthFields(body: Record<string, unknown> | null, req: Request) {
  const rtcSession = typeof body?.rtcSession === 'string' ? body.rtcSession : '';
  const fp = body?.fp_browser as { algorithm?: unknown; value?: unknown } | undefined;
  if (
    !rtcSession ||
    typeof fp !== 'object' ||
    !fp ||
    typeof fp.algorithm !== 'string' ||
    typeof fp.value !== 'string'
  ) {
    return null;
  }
  return {
    rtcSession,
    fp: { algorithm: fp.algorithm, value: fp.value },
    connectionId:
      (typeof body?.connectionId === 'string' ? body.connectionId.trim() : '') ||
      req.headers.get(X_TMEX_CONNECTION)?.trim() ||
      null,
  };
}

function toBytes(message: unknown): Uint8Array | null {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  return null;
}
