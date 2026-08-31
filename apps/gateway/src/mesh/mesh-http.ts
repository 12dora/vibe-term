import type { KeyLogEffect } from '@tmex/shared/auth';
import type { ChallengeStore } from '../auth/challenge-store';
import type { NodeSessionStore } from '../auth/node-session-store';
import type { UserKeyService } from '../auth/user-key-service';
import type { UserStore } from '../auth/user-store';
import { type AuthKeyLogPublisher, AuthRoutes, isAuthPublicPath } from './auth-routes';
import { Forwarder, rewriteSelf, takePendingForwardStream } from './forwarder';
import {
  type ConnectionLookup,
  MESH_FORWARD_WS_KIND,
  MESH_GATEWAY_WS_KIND,
  MESH_REJECT_4401_KIND,
  MESH_VIA_SELF,
  MESH_WS_KIND,
  type MeshHandleResult,
  type MeshRoles,
  type MeshRtcDeps,
  type MeshServerWebSocket,
  type MeshUpgradeServer,
  type PeerLinkProvider,
  type StreamOpener,
  WS_CLOSE_LOGIN_REQUIRED,
  WS_SESSION_VERIFY_MS,
  X_TMEX_CONNECTION,
  isStandaloneRoles,
} from './mesh-deps';
import { handleMeshInternalTmuxRequest, isMeshInternalPath } from './mesh-internal-tmux-routes';
import { MeshRoutes } from './mesh-routes';
import { isPeerInboundRequest, stripMeshPeerMarkerFromRequest } from './peer-request-marker';
import {
  type SessionMiddlewareDeps,
  authenticateRequest,
  consumeSetSessionForBrowser,
  isStandaloneOpenAuth,
  jsonBody,
  jsonError,
} from './session-middleware';
import type { UplinkStatus } from './types';

export type MeshHttpRuntimeOptions = {
  roles: MeshRoles;
  nodeId: string;
  nodePk: Uint8Array;
  userStore: UserStore;
  keyLogService: UserKeyService;
  challengeStore: ChallengeStore;
  nodeSessionStore: NodeSessionStore;
  peers: PeerLinkProvider;
  streams: StreamOpener;
  publisher: AuthKeyLogPublisher;
  rtc?: MeshRtcDeps;
  now?: () => number;
  primaryUserId?: string;
  hubPublicUrl?: string | null;
  trustProxy?: boolean;
  connectionLookup?: ConnectionLookup;
  selfStatus?: () => UplinkStatus;
  listedNames?: () => ReadonlyArray<{ id: string; name: string }>;
  selfName?: () => string | null;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  streamLog?: (line: string) => void;
};

const STATIC_PREFIXES = ['/assets/', '/static/', '/favicon', '/manifest'];

type RegisteredSocket = {
  ws: MeshServerWebSocket;
  sid: string;
  uid: string;
  lastVerifyAt: number;
};

export class MeshHttpRuntime {
  readonly auth: AuthRoutes;
  readonly mesh: MeshRoutes;
  readonly forwarder: Forwarder;
  private readonly sessionDeps: SessionMiddlewareDeps;
  private readonly roles: MeshRoles;
  private readonly nodeId: string;
  private readonly sockets = new Set<RegisteredSocket>();
  private readonly now: () => number;

  constructor(opts: MeshHttpRuntimeOptions) {
    this.roles = opts.roles;
    this.nodeId = opts.nodeId;
    this.now = opts.now ?? (() => Date.now());
    this.sessionDeps = {
      roles: opts.roles,
      nodeSessionStore: opts.nodeSessionStore,
      now: this.now,
      trustProxy: opts.trustProxy,
      localAuthEffective: () => this.auth.isLocalAuthEffective(),
    };
    this.forwarder = new Forwarder({
      nodeId: opts.nodeId,
      peers: opts.peers,
      streams: opts.streams,
      sleep: opts.sleep,
      log: opts.streamLog,
    });
    this.mesh = new MeshRoutes({
      roles: opts.roles,
      nodeId: opts.nodeId,
      nodePk: opts.nodePk,
      userStore: opts.userStore,
      nodeSessionStore: opts.nodeSessionStore,
      peers: opts.peers,
      rtcFingerprint: opts.rtc?.fingerprint,
      rtcSignals: opts.rtc?.signals,
      rtcConfig: opts.rtc?.config,
      now: this.now,
      registerSocket: (ws, auth) => this.registerSocket(ws, auth),
      connectionLookup: opts.connectionLookup,
      selfStatus: opts.selfStatus,
      listedNames: opts.listedNames,
      selfName: opts.selfName,
    });
    this.auth = new AuthRoutes({
      roles: opts.roles,
      nodeId: opts.nodeId,
      nodePk: opts.nodePk,
      userStore: opts.userStore,
      keyLogService: opts.keyLogService,
      challengeStore: opts.challengeStore,
      nodeSessionStore: opts.nodeSessionStore,
      publisher: opts.publisher,
      now: this.now,
      primaryUserId: opts.primaryUserId,
      hubPublicUrl: opts.hubPublicUrl,
      listPublicNodes: () => this.mesh.publicNodes(),
      onLogout: (userId) => this.closeSocketsForUser(userId),
      onKeyLogEffects: (userId, effects) => this.applyKeyLogEffects(userId, effects),
    });
  }

  stop(): void {
    this.mesh.stop();
    this.sockets.clear();
  }

  rewriteSelf(req: Request): Request | null {
    return rewriteSelf(req, this.nodeId);
  }

  async handleRequest(req: Request, server: MeshUpgradeServer): Promise<MeshHandleResult> {
    const safeReq = isPeerInboundRequest(req) ? req : stripMeshPeerMarkerFromRequest(req);
    const path = new URL(safeReq.url).pathname;
    if (isMeshInternalPath(path)) {
      return handleMeshInternalTmuxRequest(safeReq);
    }
    const forwarded = await this.forwarder.handle(safeReq, server);
    if (forwarded !== null) {
      return this.finalizeHandle(safeReq, forwarded);
    }
    return this.finalizeHandle(safeReq, await this.dispatchLocal(safeReq, server));
  }

  guardGatewayWebSocket(req: Request, server: MeshUpgradeServer): Response | null | undefined {
    const path = new URL(req.url).pathname;
    if (path !== '/ws' && path !== '/n/self/ws' && path !== `/n/${this.nodeId}/ws`) {
      return null;
    }
    const auth = authenticateRequest(req, this.sessionDeps);
    if (isStandaloneOpenAuth(auth)) {
      return null;
    }
    if (!auth.ok || !auth.sid || !auth.userId) {
      const upgraded = server.upgrade(req, {
        data: { kind: MESH_REJECT_4401_KIND, via: MESH_VIA_SELF },
      });
      if (!upgraded) {
        return jsonError('UNAUTHORIZED', 401);
      }
      return undefined;
    }
    const cid =
      new URL(req.url).searchParams.get('cid')?.trim() ||
      req.headers.get(X_TMEX_CONNECTION)?.trim() ||
      '';
    const upgraded = server.upgrade(req, {
      data: {
        kind: MESH_GATEWAY_WS_KIND,
        sid: auth.sid,
        uid: auth.userId,
        via: MESH_VIA_SELF,
        ...(cid ? { cid } : {}),
      },
    });
    if (!upgraded) {
      return jsonError('upgrade_failed', 500);
    }
    return undefined;
  }

  closeSocketsForUser(uid: string): void {
    for (const entry of [...this.sockets]) {
      if (entry.uid === uid) {
        this.closeRegistered(entry, WS_CLOSE_LOGIN_REQUIRED, 'NODE_LOGIN_REQUIRED');
      }
    }
  }

  closeSocketsForSid(sid: string): void {
    for (const entry of [...this.sockets]) {
      if (entry.sid === sid) {
        this.closeRegistered(entry, WS_CLOSE_LOGIN_REQUIRED, 'NODE_LOGIN_REQUIRED');
      }
    }
  }

  applyKeyLogEffects(userId: string, effects: KeyLogEffect[]): void {
    let closeAll = false;
    for (const effect of effects) {
      if (effect.type === 'revokeAllSessions') {
        closeAll = true;
      } else if (effect.type === 'revokeSessionsByCredential') {
        closeAll = true;
      } else if (effect.type === 'revokeSessionsVia') {
        closeAll = true;
      }
    }
    if (closeAll) {
      this.closeSocketsForUser(userId);
    }
    this.sweepInvalidSockets();
  }

  touchSocket(ws: MeshServerWebSocket): boolean {
    if (ws.data?.kind === MESH_REJECT_4401_KIND) {
      return false;
    }
    const entry = this.findSocket(ws);
    if (!entry) {
      return true;
    }
    const now = this.now();
    if (now - entry.lastVerifyAt < WS_SESSION_VERIFY_MS) {
      return true;
    }
    entry.lastVerifyAt = now;
    if (!entry.sid) {
      this.closeRegistered(entry, WS_CLOSE_LOGIN_REQUIRED, 'NODE_LOGIN_REQUIRED');
      return false;
    }
    const verified = this.sessionDeps.nodeSessionStore.verify(entry.sid, {
      viaNodeId: MESH_VIA_SELF,
      now,
    });
    if (!verified.ok) {
      this.closeRegistered(entry, WS_CLOSE_LOGIN_REQUIRED, 'NODE_LOGIN_REQUIRED');
      return false;
    }
    return true;
  }

  handleWebSocket = {
    open: (ws: MeshServerWebSocket): void => {
      if (ws.data?.kind === MESH_REJECT_4401_KIND) {
        try {
          ws.close(WS_CLOSE_LOGIN_REQUIRED, 'NODE_LOGIN_REQUIRED');
        } catch {
          // ignore
        }
        return;
      }
      if (ws.data?.kind === MESH_GATEWAY_WS_KIND) {
        if (ws.data.sid && ws.data.uid) {
          this.registerSocket(ws, { sid: ws.data.sid, uid: ws.data.uid });
        }
        return;
      }
      if (ws.data?.kind === MESH_WS_KIND) {
        this.mesh.handleMeshSocketOpen(ws);
        return;
      }
      if (ws.data?.kind === MESH_FORWARD_WS_KIND) {
        if (!ws.data.auth) {
          try {
            ws.close(WS_CLOSE_LOGIN_REQUIRED, 'NODE_LOGIN_REQUIRED');
          } catch {
            // ignore
          }
          return;
        }
        const stream = takePendingForwardStream(ws.data.token);
        if (!stream) {
          try {
            ws.close(1011, 'no-stream');
          } catch {
            // ignore
          }
          return;
        }
        this.forwarder.attachForwardPump(ws, stream);
      }
    },
    message: (ws: MeshServerWebSocket, message: unknown): void => {
      if (!this.touchSocket(ws)) {
        return;
      }
      if (ws.data?.kind === MESH_WS_KIND) {
        this.mesh.handleMeshSocketMessage(ws, message);
        return;
      }
      if (ws.data?.kind === MESH_FORWARD_WS_KIND) {
        this.forwarder.handleForwardSocketMessage(ws, message);
      }
    },
    close: (ws: MeshServerWebSocket, code?: number, reason?: string): void => {
      this.unregisterSocket(ws);
      if (ws.data?.kind === MESH_WS_KIND) {
        this.mesh.handleMeshSocketClose(ws);
        return;
      }
      if (ws.data?.kind === MESH_FORWARD_WS_KIND) {
        this.forwarder.handleForwardSocketClose(ws, code, reason);
      }
    },
  };

  localUiGuard(req: Request): Response | null {
    const path = new URL(req.url).pathname;
    if (path === '/login' || path.startsWith('/login/')) {
      return null;
    }
    if (isStaticAsset(path)) {
      return null;
    }
    if (isMeshInternalPath(path)) {
      return null;
    }
    if (
      isAuthPublicPath(path, {
        standalone: isStandaloneRoles(this.roles),
        localAuthEffective: this.sessionDeps.localAuthEffective?.() ?? false,
      })
    ) {
      return null;
    }
    if (path.startsWith('/api/')) {
      const auth = authenticateRequest(req, this.sessionDeps);
      if (!auth.ok) {
        return jsonError('UNAUTHORIZED', 401);
      }
    } else {
      authenticateRequest(req, this.sessionDeps);
    }
    return null;
  }

  private async dispatchLocal(
    req: Request,
    server: MeshUpgradeServer
  ): Promise<Response | null | undefined> {
    const path = new URL(req.url).pathname;
    if (path === '/healthz') {
      const auth = authenticateRequest(req, this.sessionDeps);
      if (!auth.ok) {
        return jsonBody({ status: 'ok' });
      }
      return null;
    }
    const authRes = await this.auth.handle(req);
    if (authRes) return authRes;
    const meshRes = await this.mesh.handle(req, server);
    if (meshRes !== null) return meshRes;
    return null;
  }

  private finalizeHandle(req: Request, result: MeshHandleResult): MeshHandleResult {
    if (result instanceof Response) {
      return consumeSetSessionForBrowser(req, result);
    }
    return result;
  }

  private registerSocket(ws: MeshServerWebSocket, auth: { sid: string; uid: string }): void {
    this.unregisterSocket(ws);
    this.sockets.add({
      ws,
      sid: auth.sid,
      uid: auth.uid,
      lastVerifyAt: this.now(),
    });
  }

  private unregisterSocket(ws: MeshServerWebSocket): void {
    for (const entry of this.sockets) {
      if (entry.ws === ws) {
        this.sockets.delete(entry);
        return;
      }
    }
  }

  private findSocket(ws: MeshServerWebSocket): RegisteredSocket | undefined {
    for (const entry of this.sockets) {
      if (entry.ws === ws) return entry;
    }
    return undefined;
  }

  private closeRegistered(entry: RegisteredSocket, code: number, reason: string): void {
    this.sockets.delete(entry);
    try {
      entry.ws.close(code, reason);
    } catch {
      // ignore
    }
  }

  private sweepInvalidSockets(): void {
    const now = this.now();
    for (const entry of [...this.sockets]) {
      const verified = this.sessionDeps.nodeSessionStore.verify(entry.sid, {
        viaNodeId: MESH_VIA_SELF,
        now,
      });
      if (!verified.ok) {
        this.closeRegistered(entry, WS_CLOSE_LOGIN_REQUIRED, 'NODE_LOGIN_REQUIRED');
      }
    }
  }
}

function isStaticAsset(path: string): boolean {
  for (const prefix of STATIC_PREFIXES) {
    if (path === prefix.slice(0, -1) || path.startsWith(prefix)) return true;
  }
  const last = path.split('/').pop() ?? '';
  return last.includes('.') && !last.startsWith('.');
}
