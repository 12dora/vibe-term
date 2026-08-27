import type { ChallengeStore } from '../auth/challenge-store';
import type { NodeSessionStore } from '../auth/node-session-store';
import type { UserKeyService } from '../auth/user-key-service';
import type { UserStore } from '../auth/user-store';
import { AuthRoutes } from './auth-routes';
import { Forwarder, getSelfRewrite, takePendingForwardStream } from './forwarder';
import {
  type KeyLogPublisher,
  MESH_FORWARD_WS_KIND,
  MESH_VIA_SELF,
  MESH_WS_KIND,
  type MeshRoles,
  type MeshRtcDeps,
  type MeshServerWebSocket,
  type MeshUpgradeServer,
  type PeerLinkProvider,
  type StreamOpener,
  WS_CLOSE_LOGIN_REQUIRED,
  getMeshRequestContext,
  isStandaloneRoles,
  setMeshRequestContext,
} from './mesh-deps';
import { MeshRoutes } from './mesh-routes';
import { type SessionMiddlewareDeps, authenticateRequest, jsonError } from './session-middleware';

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
  publisher: KeyLogPublisher;
  rtc?: MeshRtcDeps;
  now?: () => number;
  primaryUserId?: string;
};

const STATIC_PREFIXES = ['/assets/', '/static/', '/favicon', '/manifest'];
const PUBLIC_API = new Set([
  '/api/auth/mode',
  '/api/auth/challenge',
  '/api/auth/login',
  '/api/auth/passkey/login/options',
]);

export class MeshHttpRuntime {
  readonly auth: AuthRoutes;
  readonly mesh: MeshRoutes;
  readonly forwarder: Forwarder;
  private readonly sessionDeps: SessionMiddlewareDeps;
  private readonly roles: MeshRoles;

  constructor(opts: MeshHttpRuntimeOptions) {
    this.roles = opts.roles;
    this.sessionDeps = {
      roles: opts.roles,
      nodeSessionStore: opts.nodeSessionStore,
      now: opts.now,
    };
    this.auth = new AuthRoutes({
      roles: opts.roles,
      nodeId: opts.nodeId,
      nodePk: opts.nodePk,
      userStore: opts.userStore,
      keyLogService: opts.keyLogService,
      challengeStore: opts.challengeStore,
      nodeSessionStore: opts.nodeSessionStore,
      publisher: opts.publisher,
      now: opts.now,
      primaryUserId: opts.primaryUserId,
    });
    this.mesh = new MeshRoutes({
      roles: opts.roles,
      nodeId: opts.nodeId,
      nodePk: opts.nodePk,
      userStore: opts.userStore,
      challengeStore: opts.challengeStore,
      nodeSessionStore: opts.nodeSessionStore,
      peers: opts.peers,
      rtcFingerprint: opts.rtc?.fingerprint,
      rtcSignals: opts.rtc?.signals,
      rtcConfig: opts.rtc?.config,
      now: opts.now,
    });
    this.forwarder = new Forwarder({
      nodeId: opts.nodeId,
      peers: opts.peers,
      streams: opts.streams,
    });
  }

  stop(): void {
    this.mesh.stop();
  }

  async handleRequest(
    req: Request,
    server: MeshUpgradeServer
  ): Promise<Response | null | undefined> {
    const forwarded = await this.forwarder.handle(req, server);
    if (forwarded !== null) {
      return forwarded;
    }
    const rewrite = getSelfRewrite(req);
    if (rewrite) {
      const inner = rewriteRequest(req, rewrite);
      const handled = await this.dispatchLocal(inner, server);
      if (handled !== null) {
        return handled;
      }
      return null;
    }
    return this.dispatchLocal(req, server);
  }

  handleWebSocket = {
    open: (ws: MeshServerWebSocket): void => {
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
      if (ws.data?.kind === MESH_WS_KIND) {
        this.mesh.handleMeshSocketMessage(ws, message);
        return;
      }
      if (ws.data?.kind === MESH_FORWARD_WS_KIND) {
        this.forwarder.handleForwardSocketMessage(ws, message);
      }
    },
    close: (ws: MeshServerWebSocket, code?: number, reason?: string): void => {
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
    if (isStandaloneRoles(this.roles)) {
      return null;
    }
    const path = new URL(req.url).pathname;
    if (path === '/login' || path.startsWith('/login/')) {
      return null;
    }
    if (isStaticAsset(path)) {
      return null;
    }
    if (PUBLIC_API.has(path)) {
      return null;
    }
    if (path.startsWith('/api/')) {
      const auth = authenticateRequest(req, this.sessionDeps);
      if (!auth.ok) {
        return jsonError('UNAUTHORIZED', 401);
      }
    }
    return null;
  }

  private async dispatchLocal(
    req: Request,
    server: MeshUpgradeServer
  ): Promise<Response | null | undefined> {
    const authRes = await this.auth.handle(req);
    if (authRes) return authRes;
    const meshRes = await this.mesh.handle(req, server);
    if (meshRes !== null) return meshRes;
    return null;
  }
}

function rewriteRequest(req: Request, rewrite: string): Request {
  const url = new URL(req.url);
  const q = rewrite.indexOf('?');
  if (q === -1) {
    url.pathname = rewrite;
    url.search = '';
  } else {
    url.pathname = rewrite.slice(0, q);
    url.search = rewrite.slice(q);
  }
  const inner = new Request(url, req);
  const ctx = getMeshRequestContext(req);
  setMeshRequestContext(inner, { ...ctx, via: MESH_VIA_SELF, selfRewrite: undefined });
  return inner;
}

function isStaticAsset(path: string): boolean {
  for (const prefix of STATIC_PREFIXES) {
    if (path === prefix.slice(0, -1) || path.startsWith(prefix)) return true;
  }
  const last = path.split('/').pop() ?? '';
  return last.includes('.') && !last.startsWith('.');
}
