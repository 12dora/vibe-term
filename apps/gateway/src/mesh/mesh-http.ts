import type { KeyLogEffect } from '@vibeterm/shared/auth';
import { SHARE_WS_CLOSE_ENDED } from '@vibeterm/shared/share';
import type { HubMode } from '@vibeterm/shared/uplink';
import type { ChallengeStore } from '../auth/challenge-store';
import type { MeshHubStore } from '../auth/mesh-hub-store';
import type { NodeSessionStore } from '../auth/node-session-store';
import type { UserKeyService } from '../auth/user-key-service';
import type { UserStore } from '../auth/user-store';
import type { LocalAuthStoreLike } from '../db/local-auth-settings';
import { type AuthKeyLogPublisher, AuthRoutes, isAuthPublicPath } from './auth-routes';
import { Forwarder, rewriteSelf, takePendingForwardStream } from './forwarder';
import {
  connectionIdOf,
  isGatewayWsPath,
  rejectGatewayWs,
  upgradeBoundShareSocket,
  upgradeSessionSocket,
  upgradeShareSocket,
} from './gateway-ws-upgrade';
import {
  type ConnectionLookup,
  MESH_FORWARD_WS_KIND,
  MESH_GATEWAY_WS_KIND,
  MESH_REJECT_4401_KIND,
  MESH_SHARE_WS_KIND,
  MESH_VIA_SELF,
  MESH_WS_KIND,
  type MeshHandleResult,
  type MeshRoles,
  type MeshRtcDeps,
  type MeshServerWebSocket,
  type MeshUpgradeServer,
  type PeerLinkProvider,
  SHARE_WS_VERIFY_MS,
  type StreamOpener,
  WS_CLOSE_LOGIN_REQUIRED,
  isStandaloneRoles,
} from './mesh-deps';
import { handleMeshInternalTmuxRequest, isMeshInternalPath } from './mesh-internal-tmux-routes';
import { MeshRoutes } from './mesh-routes';
import { isPeerInboundRequest, stripMeshPeerMarkerFromRequest } from './peer-request-marker';
import { type RelayRoutes, isLocalRelayStatusRequest } from './relay-routes';
import {
  type SessionMiddlewareDeps,
  authenticateRequest,
  consumeSetSessionForBrowser,
  isStandaloneOpenAuth,
  jsonBody,
  jsonError,
} from './session-middleware';
import { sessionVerifyDeadline, sessionVerifyDue } from './session-verify-window';
import {
  readShareCookie,
  shareIdOfToken,
  shareWsCloseFor,
  shareWsParam,
  verifyShareAccessToken,
} from './share-credential';
import type { UplinkStatus } from './types';
import type { AttachedHub, UplinkCandidate } from './uplink-pool';

export type MeshHttpRuntimeOptions = {
  roles: MeshRoles;
  nodeId: string;
  nodePk: Uint8Array;
  userStore: UserStore;
  keyLogService: UserKeyService;
  challengeStore: ChallengeStore;
  nodeSessionStore: NodeSessionStore;
  peers?: PeerLinkProvider;
  streams?: StreamOpener;
  publisher: AuthKeyLogPublisher;
  rtc?: MeshRtcDeps;
  now?: () => number;
  primaryUserId?: string;
  hubPublicUrl?: string | null;
  hubStore?: MeshHubStore;
  attachedHub?: () => AttachedHub | null;
  attachedHubIdOf?: (nodeId: string) => string | null | undefined;
  hubMode?: () => HubMode | null;
  hubCandidates?: () => Array<string | UplinkCandidate>;
  trustProxy?: boolean;
  connectionLookup?: ConnectionLookup;
  selfStatus?: () => UplinkStatus;
  /** `null` = 本进程还没应用过任何成员列表（见 mesh-runtime 的实现注释）。 */
  listedNames?: () => ReadonlyArray<{ id: string; name: string }> | null;
  selfName?: () => string | null;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  streamLog?: (line: string) => void;
  /** 只挂鉴权面：不转发、不暴露 /api/mesh。缺 peers 时默认启用。 */
  authSurfaceOnly?: boolean;
  localAuth?: LocalAuthStoreLike;
  localAuthEffective?: () => boolean;
  /**
   * 会话被撤销（登出 / key log 撤销 / 改密）时，一并拆掉挂在 mesh 流上的网关会话。
   * 本地浏览器 socket 在 `sockets` 里，转发来的连接不在，只能靠这个回调即时断开——
   * 否则要等 `WS_SESSION_VERIFY_MS` 那轮复验才会掉。
   */
  onSessionsRevoked?: (target: { uid?: string; sid?: string }) => void;
};

const STATIC_PREFIXES = ['/assets/', '/static/', '/favicon', '/manifest'];

const INERT_PEERS: PeerLinkProvider = {
  getLink: async (nodeId) => {
    throw new Error(`auth-surface has no peer link for ${nodeId}`);
  },
  listReach: () => new Map(),
  onNodeEvent: () => () => {},
};

const INERT_STREAMS: StreamOpener = {
  openHttpStream: async () => new Response(null, { status: 503 }),
  openWsStream: async () => {
    throw new Error('auth-surface has no streams');
  },
};

type RegisteredSocket = {
  ws: MeshServerWebSocket;
  sid: string;
  uid: string;
  lastVerifyAt: number;
  /** 下一次允许压库复验的时刻；由 `sessionVerifyDeadline` 按会话过期时间收窄。 */
  nextVerifyAt: number;
};

/** 会带来会话失效的 key log 效果；其余记录类型不必触发 socket 复核。 */
const SESSION_REVOKE_EFFECTS: ReadonlySet<KeyLogEffect['type']> = new Set([
  'revokeAllSessions',
  'revokeSessionsByCredential',
  'revokeSessionsVia',
]);

function safeLocalAuthEffective(read: () => boolean): () => boolean {
  return () => {
    try {
      return read();
    } catch {
      return false;
    }
  };
}

export class MeshHttpRuntime {
  readonly auth: AuthRoutes;
  readonly mesh: MeshRoutes;
  readonly forwarder: Forwarder;
  readonly nodeId: string;
  private readonly sessionDeps: SessionMiddlewareDeps;
  private readonly roles: MeshRoles;
  private readonly sockets = new Set<RegisteredSocket>();
  private readonly now: () => number;
  private readonly authSurfaceOnly: boolean;
  private readonly onSessionsRevoked: MeshHttpRuntimeOptions['onSessionsRevoked'];
  private relayRoutes: RelayRoutes | null = null;

  constructor(opts: MeshHttpRuntimeOptions) {
    this.roles = opts.roles;
    this.nodeId = opts.nodeId;
    this.now = opts.now ?? (() => Date.now());
    this.authSurfaceOnly = opts.authSurfaceOnly === true || opts.peers == null;
    this.onSessionsRevoked = opts.onSessionsRevoked;
    const peers = opts.peers ?? INERT_PEERS;
    const streams = opts.streams ?? INERT_STREAMS;
    this.sessionDeps = {
      roles: opts.roles,
      nodeSessionStore: opts.nodeSessionStore,
      now: this.now,
      trustProxy: opts.trustProxy,
      localAuthEffective:
        opts.localAuthEffective ?? safeLocalAuthEffective(() => this.auth.isLocalAuthEffective()),
    };
    this.forwarder = new Forwarder({
      nodeId: opts.nodeId,
      peers,
      streams,
      sleep: opts.sleep,
      log: opts.streamLog,
    });
    this.mesh = new MeshRoutes({
      roles: opts.roles,
      nodeId: opts.nodeId,
      nodePk: opts.nodePk,
      userStore: opts.userStore,
      nodeSessionStore: opts.nodeSessionStore,
      peers,
      rtcFingerprint: opts.rtc?.fingerprint,
      rtcSignals: opts.rtc?.signals,
      rtcConfig: opts.rtc?.config,
      now: this.now,
      registerSocket: (ws, auth) => this.registerSocket(ws, auth),
      connectionLookup: opts.connectionLookup,
      selfStatus: opts.selfStatus,
      listedNames: opts.listedNames,
      selfName: opts.selfName,
      hubStore: opts.hubStore,
      attachedHub: opts.attachedHub,
      attachedHubIdOf: opts.attachedHubIdOf,
      hubCandidates: opts.hubCandidates,
      forwardAuthorizedHttp: (req, input) => this.forwarder.forwardAuthorizedHttp(req, input),
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
      hubStore: opts.hubStore,
      attachedHub: opts.attachedHub,
      hubMode: opts.hubMode,
      listPublicNodes: this.authSurfaceOnly
        ? () => [{ id: opts.nodeId, name: 'self', online: true }]
        : () => this.mesh.publicNodes(),
      onLogout: (userId) => this.closeSocketsForUser(userId),
      onKeyLogEffects: (userId, effects) => this.applyKeyLogEffects(userId, effects),
      localAuth: opts.localAuth,
    });
    this.forwarder.setAuthRateLimits(this.auth.rateLimits);
  }

  /** 由 mesh-runtime 在装配后注入：中继模式的 `/api/mesh/relay/*`。 */
  setRelayRoutes(routes: RelayRoutes | null): void {
    this.relayRoutes = routes;
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
    if (this.authSurfaceOnly) {
      return this.finalizeHandle(safeReq, await this.dispatchLocal(safeReq, server));
    }
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

  /**
   * 鉴权优先级：`?share=<id>` 存在时只认绑定该分享的凭证（不回退常规会话）；
   * 否则常规会话优先，其次有效的分享 cookie，最后才是 standalone 开放短路——
   * 分享凭证必须在开放短路之前判定，否则免登录部署会把分享连接升级成全权限连接。
   */
  guardGatewayWebSocket(req: Request, server: MeshUpgradeServer): Response | null | undefined {
    const url = new URL(req.url);
    if (!isGatewayWsPath(url.pathname, this.nodeId)) {
      return null;
    }
    const token = readShareCookie(req, MESH_VIA_SELF);
    const boundShareId = shareWsParam(url);
    if (boundShareId) {
      return upgradeBoundShareSocket(req, server, token, boundShareId, this.now());
    }
    const auth = authenticateRequest(req, this.sessionDeps);
    if (auth.ok && auth.sid && auth.userId) {
      return upgradeSessionSocket(req, server, { sid: auth.sid, uid: auth.userId });
    }
    const verified = verifyShareAccessToken(token, this.now());
    if (token && verified) {
      return upgradeShareSocket(req, server, token, verified, this.now());
    }
    if (isStandaloneOpenAuth(auth)) {
      return null;
    }
    return rejectGatewayWs(req, server, token ? shareWsCloseFor(shareIdOfToken(token)) : null);
  }

  closeSocketsForUser(uid: string): void {
    for (const entry of [...this.sockets]) {
      if (entry.uid === uid) {
        this.closeRegistered(entry, WS_CLOSE_LOGIN_REQUIRED, 'NODE_LOGIN_REQUIRED');
      }
    }
    this.onSessionsRevoked?.({ uid });
  }

  closeSocketsForSid(sid: string): void {
    for (const entry of [...this.sockets]) {
      if (entry.sid === sid) {
        this.closeRegistered(entry, WS_CLOSE_LOGIN_REQUIRED, 'NODE_LOGIN_REQUIRED');
      }
    }
    this.onSessionsRevoked?.({ sid });
  }

  /**
   * 会话效果落库后按**会话真实状态**复核，而不是「有撤销效果就把这个用户全踢下线」：
   * 一次 `remove-passkey` 只吊销该凭证签发的会话，别的标签页照样有效。挂在 mesh 流上的
   * 会话由 `onSessionsRevoked` 那侧自己复验。没有会话类效果的记录（改名、汇聚声明等）
   * 不必扫——`onApplied` 每条记录都会走到这里。
   */
  applyKeyLogEffects(userId: string, effects: KeyLogEffect[]): void {
    if (!effects.some((effect) => SESSION_REVOKE_EFFECTS.has(effect.type))) return;
    this.sweepInvalidSockets();
    this.onSessionsRevoked?.({ uid: userId });
  }

  touchSocket(ws: MeshServerWebSocket): boolean {
    if (ws.data?.kind === MESH_REJECT_4401_KIND) {
      return false;
    }
    if (ws.data?.kind === MESH_SHARE_WS_KIND) {
      return this.touchShareSocket(ws);
    }
    const entry = this.findSocket(ws);
    if (!entry) {
      return true;
    }
    const now = this.now();
    if (!sessionVerifyDue(entry, now)) {
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
    // 复验窗口不越过会话自身的过期时刻，TTL / 硬过期不会被节流拖软。
    entry.nextVerifyAt = sessionVerifyDeadline(verified.session, now);
    return true;
  }

  handleWebSocket = {
    open: (ws: MeshServerWebSocket): void => {
      if (ws.data?.kind === MESH_REJECT_4401_KIND) {
        try {
          ws.close(
            ws.data.closeCode ?? WS_CLOSE_LOGIN_REQUIRED,
            ws.data.closeReason ?? 'NODE_LOGIN_REQUIRED'
          );
        } catch {
          // ignore
        }
        return;
      }
      if (ws.data?.kind === MESH_SHARE_WS_KIND) {
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
    drain: (ws: MeshServerWebSocket): void => {
      if (ws.data?.kind === MESH_FORWARD_WS_KIND) {
        this.forwarder.handleForwardSocketDrain(ws);
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
        method: req.method,
      })
    ) {
      return null;
    }
    if (path.startsWith('/api/')) {
      if (isLocalRelayStatusRequest(req, path)) {
        return null;
      }
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
    if (this.authSurfaceOnly) return null;
    const relayRes = await this.relayRoutes?.handle(req, path);
    if (relayRes) return relayRes;
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

  /** 分享连接不进 sockets 索引：按 SHARE_WS_VERIFY_MS 复验凭证，失效即 4410 断开。 */
  private touchShareSocket(ws: MeshServerWebSocket): boolean {
    const now = this.now();
    const last = ws.data.shareVerifiedAt ?? 0;
    if (now - last < SHARE_WS_VERIFY_MS) {
      return true;
    }
    ws.data.shareVerifiedAt = now;
    const verified = verifyShareAccessToken(ws.data.shareToken, now);
    if (verified) {
      ws.data.scope = verified.scope;
      return true;
    }
    try {
      ws.close(SHARE_WS_CLOSE_ENDED, 'SHARE_ENDED');
    } catch {
      // ignore
    }
    return false;
  }

  private registerSocket(ws: MeshServerWebSocket, auth: { sid: string; uid: string }): void {
    this.unregisterSocket(ws);
    // 升级时刚验过，这里再读一次只为拿到过期时刻把复验窗口收窄；读不到就下一帧立刻复验。
    const now = this.now();
    const verified = this.sessionDeps.nodeSessionStore.verify(auth.sid, {
      viaNodeId: MESH_VIA_SELF,
      now,
    });
    this.sockets.add({
      ws,
      sid: auth.sid,
      uid: auth.uid,
      lastVerifyAt: now,
      nextVerifyAt: verified.ok ? sessionVerifyDeadline(verified.session, now) : now,
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
