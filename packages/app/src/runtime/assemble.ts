import { resolve } from 'node:path';
import {
  PROCESS_STARTED_AT,
  setHealthzTlsProvider,
} from '../../../../apps/gateway/src/api/system-routes';
import { ChallengeStore } from '../../../../apps/gateway/src/auth/challenge-store';
import { MeshHubStore } from '../../../../apps/gateway/src/auth/mesh-hub-store';
import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { NodeIdentityStore } from '../../../../apps/gateway/src/auth/node-identity-store';
import type { NodeSessionStore } from '../../../../apps/gateway/src/auth/node-session-store';
import { config as gatewayConfig } from '../../../../apps/gateway/src/config';
import { runtimeController } from '../../../../apps/gateway/src/control/runtime';
import {
  LocalAuthStore,
  readLocalAuthEffective,
} from '../../../../apps/gateway/src/db/local-auth-settings';
import type { HubRuntime, HubServerWebSocket } from '../../../../apps/gateway/src/hub';
import {
  MESH_FORWARD_WS_KIND,
  MESH_GATEWAY_WS_KIND,
  MESH_REJECT_4401_KIND,
  MESH_VIA_SELF,
  MESH_WS_KIND,
  type MeshRewritten,
  WS_CLOSE_LOGIN_REQUIRED,
  getMeshRequestContext,
  isMeshRewritten,
  setMeshRequestContext,
} from '../../../../apps/gateway/src/mesh/mesh-deps';
import { MeshHttpRuntime } from '../../../../apps/gateway/src/mesh/mesh-http';
import {
  type CreateMeshRuntimeOptions,
  type MeshRuntime,
  createMeshRuntime,
} from '../../../../apps/gateway/src/mesh/mesh-runtime';
import type { LoadNative } from '../../../../apps/gateway/src/mesh/rtc';
import {
  applyLocalRenewal,
  authenticateRequest,
} from '../../../../apps/gateway/src/mesh/session-middleware';
import type { GatewayRuntime } from '../../../../apps/gateway/src/runtime';
import { resolveInstallDir as resolveGatewayInstallDir } from '../../../../apps/gateway/src/system/install-info';
import { getBaseVersion } from '../../../../apps/gateway/src/system/version';
import { TlsConfigStore } from '../../../../apps/gateway/src/tls/tls-config-store';
import { guardEntryAccess } from '../../../../apps/gateway/src/tunnel/access-guard';
import { tunnelManager } from '../../../../apps/gateway/src/tunnel/manager';
import type { GatewaySession } from '../../../../apps/gateway/src/ws/gateway-session';
import { readNodeEnv } from '../../../../packages/shared/src/env/load-env';
import { disableDirect, enableDirect } from '../commands/direct';
import { performHubJoin } from '../commands/hub';
import { readEnvFile, writeEnvFile } from '../lib/env-file';
import { withEnvLock } from '../lib/env-mutation';
import { type LocalAuthContext, createAuthContextFromDb } from '../lib/local-auth';
import { loadNodeDatachannel } from '../lib/native-datachannel';
import { detectCurrentNativePin } from '../lib/native-manifest';
import { type TmexRoles, parseTmexRoles } from '../lib/roles';
import { AcmeHttp01Challenge } from '../tls/acme-challenge';
import { HttpsListener } from '../tls/https-listener';
import { TlsService } from '../tls/tls-service';
import { createTmexGatewayRuntime } from './gateway';
import { jsonErr } from './http';
import { type LocalRouteDeps, handleLocalRequest } from './local-routes';
import { type RuntimeMode, handlePreflightHttp, readRuntimeMode } from './mode';
import { serveFrontend as defaultServeFrontend } from './serve-frontend';
import { handleSetupRequest } from './setup-routes';
import { SETUP_RESTART_DELAY_MS, resolveSetupEnvPath } from './setup-service';
import { createTlsRoutes } from './tls-routes';

export const SHUTDOWN_TIMEOUT_MS = 20_000;

export function meshShutdownNeeded(roles: TmexRoles): boolean {
  return roles.hub || roles.node;
}

type AssembleTmexOptions = {
  roles?: TmexRoles;
  staticRoot?: string;
  runtimeMode?: RuntimeMode;
  createGatewayRuntime?: () => Promise<GatewayRuntime>;
  createMeshRuntime?: (opts: CreateMeshRuntimeOptions) => Promise<MeshRuntime>;
  serveFrontend?: (req: Request, staticRoot: string) => Promise<Response>;
  hub?: HubRuntime;
  loadNative?: LoadNative;
  nativeDir?: string;
  localAuthEffective?: () => boolean;
};

type AssembledTmex = {
  roles: TmexRoles;
  gateway: GatewayRuntime;
  mesh: MeshRuntime | null;
  hub: HubRuntime | null;
  tls: TlsService;
  httpsListener: HttpsListener;
  fetch: (
    req: Request,
    bunServer: Bun.Server<unknown>
  ) => Response | Promise<Response | undefined> | undefined;
  websocket: GatewayRuntime['websocket'];
  start: () => Promise<void>;
  stop: () => Promise<void>;
  setProcessShutdown: (run: () => Promise<void>) => void;
  isRestartRequested: () => boolean;
};

type HttpResult = Response | null | undefined | MeshRewritten;
type HttpHandler = (req: Request, server: Bun.Server<unknown>) => HttpResult | Promise<HttpResult>;

function createRouteAuthenticate(
  roles: TmexRoles,
  nodeSessionStore: NodeSessionStore,
  localAuthEffective: () => boolean
): LocalRouteDeps['authenticate'] {
  return (req) => {
    try {
      return authenticateRequest(req, { roles, nodeSessionStore, localAuthEffective });
    } catch {
      return { ok: false };
    }
  };
}

function defaultStaticRoot(): string {
  return process.env.TMEX_FE_DIST_DIR
    ? resolve(process.env.TMEX_FE_DIST_DIR)
    : resolve(import.meta.dir, '../../resources/fe-dist');
}

function socketKind(ws: { data?: unknown }): string | undefined {
  const kind = (ws.data as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' ? kind : undefined;
}

function isMeshKind(kind: string | undefined): boolean {
  return (
    kind === MESH_WS_KIND ||
    kind === MESH_FORWARD_WS_KIND ||
    kind === MESH_REJECT_4401_KIND ||
    kind === MESH_GATEWAY_WS_KIND
  );
}

function seedLocalContext(req: Request, bunServer: Bun.Server<unknown>): void {
  const existing = getMeshRequestContext(req);
  let clientIp = existing.clientIp;
  try {
    clientIp ??= bunServer.requestIP(req)?.address || undefined;
  } catch {}
  setMeshRequestContext(req, {
    ...existing,
    via: existing.via || MESH_VIA_SELF,
    clientIp,
    trustProxy: gatewayConfig.trustProxy,
  });
}

async function attachStartedAt(resp: Response): Promise<Response> {
  const text = await resp.text();
  const passthrough = () => new Response(text, { status: resp.status, headers: resp.headers });
  try {
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return passthrough();
    const next = body as Record<string, unknown>;
    if (typeof next.startedAt !== 'number') next.startedAt = PROCESS_STARTED_AT;
    if (typeof next.version !== 'string' || !next.version) next.version = getBaseVersion();
    const headers = new Headers(resp.headers);
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(next), { status: resp.status, headers });
  } catch {
    return passthrough();
  }
}

async function tryStop(run: () => unknown, label?: string): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (label) console.error(`[tmex] ${label} stop failed`, err);
  }
}

type HttpAuthSurface = {
  nodeId: string;
  localUiGuard(req: Request): Response | null;
  guardGatewayWebSocket(req: Request, server: Bun.Server<unknown>): Response | null | undefined;
  handleRequest(
    req: Request,
    server: Bun.Server<unknown>
  ): ReturnType<MeshRuntime['handleRequest']>;
};

type GatewayWsAuth = Pick<MeshRuntime, 'websocket' | 'touchSocket'> & {
  registerGatewaySession?: MeshRuntime['registerGatewaySession'];
  unregisterGatewaySession?: MeshRuntime['unregisterGatewaySession'];
};

async function meshHttp(
  surface: HttpAuthSurface | null,
  req: Request,
  server: Bun.Server<unknown>
): Promise<HttpResult> {
  if (!surface) return null;
  const path = new URL(req.url).pathname;
  if (path.startsWith('/api/')) {
    const blocked = surface.localUiGuard(req);
    if (blocked) return blocked;
  }
  if (path === '/ws' || path === '/n/self/ws' || path === `/n/${surface.nodeId}/ws`) {
    const wsGuard = surface.guardGatewayWebSocket(req, server);
    if (wsGuard !== null) return wsGuard ?? undefined;
  }
  const meshResp = await surface.handleRequest(req, server);
  if (isMeshRewritten(meshResp) || meshResp == null) return meshResp;
  const next =
    path === '/healthz' && req.method === 'GET' ? await attachStartedAt(meshResp) : meshResp;
  return applyLocalRenewal(req, next);
}

async function gatewayHttp(
  gateway: GatewayRuntime,
  renewSession: boolean,
  req: Request,
  server: Bun.Server<unknown>
): Promise<HttpResult> {
  const gatewayResp = await gateway.handleRequest(req, server);
  if (gatewayResp instanceof Response)
    return renewSession ? applyLocalRenewal(req, gatewayResp) : gatewayResp;
  if (gatewayResp === undefined && new URL(req.url).pathname === '/ws') return undefined;
  return null;
}

function createHttpDispatch(handlers: HttpHandler[]): AssembledTmex['fetch'] {
  const dispatch = async (
    req: Request,
    bunServer: Bun.Server<unknown>,
    rewritten: boolean
  ): Promise<Response | undefined> => {
    seedLocalContext(req, bunServer);
    if (!rewritten) {
      const denied = await guardEntryAccess(req);
      if (denied) return denied;
    }
    for (const handler of handlers) {
      const out = await handler(req, bunServer);
      if (isMeshRewritten(out)) {
        if (!rewritten) return dispatch(out.rewritten, bunServer, true);
        continue;
      }
      if (out !== null) return out ?? undefined;
    }
  };
  return (req, bunServer) => dispatch(req, bunServer, false);
}

function routeWebsocket(
  gateway: GatewayRuntime,
  mesh: GatewayWsAuth | null,
  hub: HubRuntime | null
): GatewayRuntime['websocket'] {
  const gw = gateway.websocket;
  return {
    backpressureLimit: gw.backpressureLimit,
    closeOnBackpressureLimit: gw.closeOnBackpressureLimit,
    open(ws) {
      if (hub?.isUplinkSocket(ws)) {
        hub.handleUplinkOpen(ws as HubServerWebSocket);
        return;
      }
      const kind = socketKind(ws);
      if (!(mesh && isMeshKind(kind))) {
        gw.open(ws);
        return;
      }
      const data = ws.data as { sid?: string; uid?: string; via?: string; cid?: string };
      mesh.websocket.open(ws as never);
      if (kind !== MESH_GATEWAY_WS_KIND) return;
      gw.open(ws);
      const session = (ws.data as { session?: GatewaySession }).session;
      if (!data.sid || !data.uid || !session) return;
      const cid = typeof data.cid === 'string' && data.cid.trim() ? data.cid.trim() : '';
      const registered = mesh.registerGatewaySession?.({
        sid: data.sid,
        uid: data.uid,
        via: data.via ?? MESH_VIA_SELF,
        session,
        ...(cid ? { cid } : {}),
      });
      if (registered && !registered.ok) {
        gw.closeSession(session, WS_CLOSE_LOGIN_REQUIRED, registered.code);
      }
    },
    message(ws, message) {
      if (hub?.isUplinkSocket(ws)) {
        hub.handleUplinkMessage(ws as HubServerWebSocket, message);
        return;
      }
      const kind = socketKind(ws);
      if (mesh && isMeshKind(kind)) {
        if (kind === MESH_GATEWAY_WS_KIND) {
          if (!mesh.touchSocket(ws as never)) return;
          gw.message(ws, message);
          return;
        }
        mesh.websocket.message(ws as never, message);
        return;
      }
      if (mesh && !mesh.touchSocket(ws as never)) return;
      gw.message(ws, message);
    },
    drain(ws) {
      if (hub?.isUplinkSocket(ws)) {
        hub.handleUplinkDrain(ws as HubServerWebSocket);
        return;
      }
      if (mesh && isMeshKind(socketKind(ws)) && socketKind(ws) !== MESH_GATEWAY_WS_KIND) {
        mesh.websocket.drain(ws as never);
        return;
      }
      gw.drain(ws);
    },
    close(ws, code, reason) {
      if (hub?.isUplinkSocket(ws)) {
        hub.handleUplinkClose(ws as HubServerWebSocket, code, reason);
        return;
      }
      if (mesh) {
        const session = (ws.data as { session?: GatewaySession }).session;
        if (session) mesh.unregisterGatewaySession?.(session);
        mesh.websocket.close(ws as never, code, reason);
        if (isMeshKind(socketKind(ws)) && socketKind(ws) !== MESH_GATEWAY_WS_KIND) return;
      }
      gw.close(ws, code, reason);
    },
    closeSession(session, code, reason) {
      gw.closeSession(session, code, reason);
    },
  };
}

async function advertisedTlsInfo(
  service: TlsService | undefined
): Promise<{ caFingerprint: string | null; caPem: string | null }> {
  if (!service) return { caFingerprint: null, caPem: null };
  const status = await service.status();
  if (!status.listener.running) return { caFingerprint: null, caPem: null };
  return {
    caFingerprint: status.caFingerprint,
    caPem: (await service.caPem()) ?? null,
  };
}

function buildTlsLifecycle(
  fetch: AssembledTmex['fetch'],
  websocket: GatewayRuntime['websocket'],
  db: GatewayRuntime['db'],
  routeDeps: LocalRouteDeps,
  tlsSlot: { service?: TlsService },
  hooks?: {
    onStatusChange?: () => void;
    onTlsApplied?: () => void | Promise<void>;
  }
) {
  const httpsListener = new HttpsListener({
    fetch,
    websocket,
    log: (message) => console.log(`[tmex] ${message}`),
  });
  const tls = new TlsService({
    store: new TlsConfigStore(db),
    listener: httpsListener,
    challenge: new AcmeHttp01Challenge(),
    envPath: resolveSetupEnvPath(),
    trustProxy: gatewayConfig.trustProxy,
    onStatusChange: hooks?.onStatusChange,
  });
  tlsSlot.service = tls;
  tunnelManager.setPatchHostEnv(async (trustProxy) => {
    const envPath = resolveSetupEnvPath();
    await withEnvLock(async () => {
      let existing: Record<string, string> = {};
      try {
        existing = await readEnvFile(envPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await writeEnvFile(envPath, {
        ...existing,
        TMEX_TRUST_PROXY: trustProxy ? 'true' : 'false',
      });
    });
  });
  tunnelManager.setReadHostEnv(async () => {
    const envPath = resolveSetupEnvPath();
    try {
      const existing = await readEnvFile(envPath);
      const raw = existing.TMEX_TRUST_PROXY;
      if (raw === undefined) return null;
      const value = raw.trim().toLowerCase();
      return value === '1' || value === 'true' || value === 'yes';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  });
  return {
    tls,
    httpsListener,
    tlsHandler: createTlsRoutes({
      service: tls,
      authorize: async (req) =>
        routeDeps.authenticate(req).ok ? null : jsonErr('UNAUTHORIZED', 'login required', 401),
      onApplied: hooks?.onTlsApplied,
      configuredPublicUrl: routeDeps.roles.hub
        ? (gatewayConfig.hubPublicUrl ?? gatewayConfig.baseUrl)
        : gatewayConfig.baseUrl,
    }),
  };
}

function wsAuthFrom(http: MeshHttpRuntime | null): GatewayWsAuth | null {
  if (!http) return null;
  return {
    websocket: {
      open: (ws) => http.handleWebSocket.open(ws),
      message: (ws, message) => http.handleWebSocket.message(ws, message),
      drain() {},
      close: (ws, code, reason) => http.handleWebSocket.close(ws, code, reason),
    },
    touchSocket: (ws) => http.touchSocket(ws),
  };
}

async function standaloneNodeKeys(identityStore: LocalAuthContext['identityStore']) {
  try {
    return await ensureNodeIdentity(identityStore);
  } catch {
    return { nodeIdHex: '00'.repeat(16), edPublicKey: new Uint8Array(32) };
  }
}

async function createStandaloneAuthHttp(input: {
  roles: TmexRoles;
  gateway: GatewayRuntime;
  auth: LocalAuthContext;
  localAuthEffective?: () => boolean;
  tlsSlot: { service?: TlsService };
}): Promise<MeshHttpRuntime> {
  const keys = await standaloneNodeKeys(input.auth.identityStore);
  const runtime = new MeshHttpRuntime({
    roles: input.roles,
    nodeId: keys.nodeIdHex,
    nodePk: keys.edPublicKey,
    userStore: input.auth.userStore,
    keyLogService: input.auth.userKeys,
    challengeStore: new ChallengeStore(),
    nodeSessionStore: input.auth.nodeSessionStore,
    publisher: { publish() {} },
    authSurfaceOnly: true,
    trustProxy: gatewayConfig.trustProxy,
    localAuth: new LocalAuthStore(input.gateway.db),
    localAuthEffective: input.localAuthEffective,
  });
  runtime.auth.setTlsInfo(() => advertisedTlsInfo(input.tlsSlot.service));
  return runtime;
}

type MeshHubAssembleOpts = CreateMeshRuntimeOptions & {
  meshHubStore?: MeshHubStore;
  meshHubs?: MeshHubStore;
  config: CreateMeshRuntimeOptions['config'] & {
    hubMode?: string;
    hubPriority?: number;
    hubWriterEpoch?: number;
    hubNodeId?: string;
  };
};

async function createNodeMesh(input: {
  roles: TmexRoles;
  gateway: GatewayRuntime;
  createMesh: (opts: CreateMeshRuntimeOptions) => Promise<MeshRuntime>;
  hub?: HubRuntime;
  loadNative?: LoadNative;
  nativeDir?: string;
  tlsSlot: { service?: TlsService };
  meshHubStore?: MeshHubStore;
}): Promise<MeshRuntime> {
  const nativeDir = input.nativeDir ?? process.env.TMEX_NATIVE_DIR ?? '';
  const identity = await new NodeIdentityStore(input.gateway.db).load();
  const opts: MeshHubAssembleOpts = {
    db: input.gateway.db,
    gateway: input.gateway,
    config: {
      roles: input.roles,
      hubUrl: gatewayConfig.hubUrl,
      hubPublicUrl: gatewayConfig.hubPublicUrl,
      hubUrls: gatewayConfig.hubUrls,
      hubMode: gatewayConfig.hubMode,
      hubPriority: gatewayConfig.hubPriority,
      hubWriterEpoch: gatewayConfig.hubWriterEpoch,
      hubPeers: gatewayConfig.hubPeers,
      hubNodeId: identity?.nodeId,
      peerPort: gatewayConfig.peerPort,
      stunServers: gatewayConfig.stunServers,
      turnUrl: gatewayConfig.turnUrl,
      turnUsername: gatewayConfig.turnUsername,
      turnCredential: gatewayConfig.turnCredential,
      bindHost: process.env.TMEX_BIND_HOST || '127.0.0.1',
      peerBindHost: gatewayConfig.peerBindHost,
    },
    hub: input.hub,
    meshHubStore: input.meshHubStore,
    meshHubs: input.meshHubStore,
    loadNative:
      input.loadNative ??
      (async () =>
        process.env.TMEX_DIRECT_ENABLED === 'false' || !nativeDir
          ? null
          : loadNodeDatachannel({ nativeDir })),
    userId: identity?.userId ?? undefined,
    tlsInfo: () => advertisedTlsInfo(input.tlsSlot.service),
    patchHubRoleEnv: async (patch) => {
      const envPath = resolveSetupEnvPath();
      await withEnvLock(async () => {
        let existing: Record<string, string> = {};
        try {
          existing = await readEnvFile(envPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await writeEnvFile(envPath, { ...existing, ...patch });
      });
    },
    scheduleHubRoleRestart: (delayMs) => {
      setTimeout(() => {
        void runtimeController.requestRestart();
      }, delayMs);
    },
  };
  return input.createMesh(opts);
}

function resolveLocalAuthEffective(
  injected: (() => boolean) | undefined,
  authHttp: MeshHttpRuntime | null
): () => boolean {
  if (injected) return injected;
  if (!authHttp) return readLocalAuthEffective;
  return safeAssembleLocalAuth(authHttp);
}

function safeAssembleLocalAuth(authHttp: MeshHttpRuntime): () => boolean {
  return () => {
    try {
      return authHttp.auth.isLocalAuthEffective();
    } catch {
      return false;
    }
  };
}

function dummyTlsLifecycle(): { tls: TlsService; httpsListener: HttpsListener } {
  const httpsListener = new HttpsListener({
    fetch: async () => new Response('Not Found', { status: 404 }),
    websocket: {
      open() {},
      message() {},
      drain() {},
      close() {},
    },
  });
  return {
    httpsListener,
    tls: {
      async startup() {},
      stop() {},
    } as TlsService,
  };
}

async function assemblePreflightTmex(opts: AssembleTmexOptions): Promise<AssembledTmex> {
  const roles = opts.roles ?? parseTmexRoles(process.env.TMEX_ROLES);
  const createGateway =
    opts.createGatewayRuntime ?? (() => createTmexGatewayRuntime(undefined, { mode: 'preflight' }));
  const gateway = await createGateway();
  const { tls, httpsListener } = dummyTlsLifecycle();
  return {
    roles,
    gateway,
    mesh: null,
    hub: opts.hub ?? null,
    tls,
    httpsListener,
    fetch: (req) => handlePreflightHttp(req, getBaseVersion(), PROCESS_STARTED_AT),
    websocket: gateway.websocket,
    async start() {},
    async stop() {
      await tryStop(() => gateway.stop(), 'gateway');
    },
    setProcessShutdown() {},
    isRestartRequested() {
      return false;
    },
  };
}

async function createAssembleAuthSurface(input: {
  roles: TmexRoles;
  gateway: GatewayRuntime;
  opts: AssembleTmexOptions;
  createMesh: (opts: CreateMeshRuntimeOptions) => Promise<MeshRuntime>;
  tlsSlot: { service?: TlsService };
  meshHubStore?: MeshHubStore;
}) {
  const auth = await createAuthContextFromDb(input.gateway.db, {
    installDir: resolveGatewayInstallDir(),
    envPath: resolveSetupEnvPath(),
    env: {
      TMEX_ROLES: process.env.TMEX_ROLES ?? '',
      TMEX_HUB_URL: process.env.TMEX_HUB_URL ?? '',
      TMEX_HUB_PUBLIC_URL: process.env.TMEX_HUB_PUBLIC_URL ?? '',
    },
  });
  let mesh: MeshRuntime | null = null;
  let authHttp: MeshHttpRuntime | null = null;
  if (input.roles.node) {
    mesh = await createNodeMesh({
      roles: input.roles,
      gateway: input.gateway,
      createMesh: input.createMesh,
      hub: input.opts.hub,
      loadNative: input.opts.loadNative,
      nativeDir: input.opts.nativeDir,
      tlsSlot: input.tlsSlot,
      meshHubStore: input.meshHubStore,
    });
  } else {
    authHttp = await createStandaloneAuthHttp({
      roles: input.roles,
      gateway: input.gateway,
      auth,
      localAuthEffective: input.opts.localAuthEffective,
      tlsSlot: input.tlsSlot,
    });
  }
  return { auth, mesh, authHttp, hub: mesh?.hub ?? input.opts.hub ?? null };
}

export async function assembleTmex(opts: AssembleTmexOptions = {}): Promise<AssembledTmex> {
  const runtimeMode = opts.runtimeMode ?? readRuntimeMode();
  if (runtimeMode === 'preflight') return assemblePreflightTmex(opts);
  const roles = opts.roles ?? parseTmexRoles(process.env.TMEX_ROLES);
  const staticRoot = opts.staticRoot ?? defaultStaticRoot();
  const createGateway =
    opts.createGatewayRuntime ?? (() => createTmexGatewayRuntime(undefined, { mode: runtimeMode }));
  const createMesh = opts.createMeshRuntime ?? createMeshRuntime;
  const serveFrontend = opts.serveFrontend ?? defaultServeFrontend;
  const gateway = await createGateway();
  const tlsSlot: { service?: TlsService } = {};
  const meshHubStore = roles.hub || roles.node ? new MeshHubStore(gateway.db) : undefined;
  const { auth, mesh, authHttp, hub } = await createAssembleAuthSurface({
    roles,
    gateway,
    opts,
    createMesh,
    tlsSlot,
    meshHubStore,
  });
  const localAuthEffective = resolveLocalAuthEffective(opts.localAuthEffective, authHttp);
  if (roles.hub) {
    console.log(
      `[hub] mode=${gatewayConfig.hubMode} priority=${gatewayConfig.hubPriority} writerEpoch=${gatewayConfig.hubWriterEpoch} publicUrl=${gatewayConfig.hubPublicUrl ?? ''}`
    );
  }
  let unsubscribeNodeList: (() => void) | undefined;
  if (
    mesh &&
    hub &&
    typeof mesh.onNodeList === 'function' &&
    typeof hub.applyReplicatedNodeList === 'function'
  ) {
    unsubscribeNodeList = mesh.onNodeList((list, meta) => {
      hub.applyReplicatedNodeList(list, meta);
    });
  }

  let processShutdown: (() => Promise<void>) | null = null;
  let restartRequested = false;
  const scheduleRestart = (): void => {
    restartRequested = true;
    setTimeout(
      () => void (processShutdown ? processShutdown() : process.exit(0)),
      SETUP_RESTART_DELAY_MS
    );
  };

  const routeDeps: LocalRouteDeps = {
    roles,
    nodeEnv: readNodeEnv(),
    auth,
    precheckCaPem: async () => (await tlsSlot.service?.caPem()) ?? null,
    envPath: auth.envPath,
    installDir: auth.installDir,
    hubUrl: gatewayConfig.hubUrl,
    hubPublicUrl: gatewayConfig.hubPublicUrl,
    enableDirect,
    disableDirect,
    isDirectSupported: () => detectCurrentNativePin() != null,
    get rtcCapable() {
      return Boolean(mesh?.rtc?.available);
    },
    platform: `${process.platform}-${process.arch}`,
    performHubJoin,
    scheduleRestart,
    quiesceMesh: async () => {
      await tryStop(() => mesh?.stop());
      await tryStop(() => hub?.stop());
    },
    startedAt: PROCESS_STARTED_AT,
    authenticate: createRouteAuthenticate(roles, auth.nodeSessionStore, localAuthEffective),
    tlsStatus: async () => {
      if (!tlsSlot.service) throw new Error('tls service is not initialized');
      const { mode, listener, tlsPort } = await tlsSlot.service.status();
      return { mode, listenerRunning: listener.running, tlsPort };
    },
  };

  const authSurface = mesh ?? authHttp;
  let tlsHandler: (req: Request) => Promise<Response | null> = async () => null;
  const fetch = createHttpDispatch([
    (req) => tlsHandler(req),
    (req) => handleLocalRequest(req, routeDeps),
    (req) => handleSetupRequest(req, routeDeps),
    (req, server) =>
      hub ? hub.handleRequest(req, server).then((r) => (r instanceof Response ? r : null)) : null,
    (req, server) => meshHttp(authSurface, req, server),
    (req, server) => gatewayHttp(gateway, Boolean(authSurface), req, server),
    (req) => serveFrontend(req, staticRoot),
  ]);
  const websocket = routeWebsocket(gateway, mesh ?? wsAuthFrom(authHttp), hub);
  const invalidateTlsCaches = () => {
    authHttp?.auth.invalidateAuthModeCache();
    mesh?.invalidateAuthModeCache();
  };
  const refreshMeshTls = () => {
    invalidateTlsCaches();
    void (async () => {
      try {
        const tls = await advertisedTlsInfo(tlsSlot.service);
        if (hub && typeof hub.updateSelfCaFingerprint === 'function') {
          hub.updateSelfCaFingerprint(tls.caFingerprint);
        }
      } catch {
        /* fake db in unit tests has no tls_config table */
      }
      await mesh?.refreshTlsAndAdvertise();
    })();
  };
  const tlsLife = buildTlsLifecycle(fetch, websocket, gateway.db, routeDeps, tlsSlot, {
    onStatusChange: refreshMeshTls,
    onTlsApplied: invalidateTlsCaches,
  });
  tlsHandler = tlsLife.tlsHandler;
  void mesh?.refreshTlsAndAdvertise();
  setHealthzTlsProvider(async () => {
    const status = await tlsLife.tls.status();
    return { mode: status.mode, listenerRunning: status.listener.running };
  });

  let stopPromise: Promise<void> | null = null;
  return {
    roles,
    gateway,
    mesh,
    hub,
    tls: tlsLife.tls,
    httpsListener: tlsLife.httpsListener,
    fetch,
    websocket,
    async start() {
      await mesh?.start();
      gateway.restoreRemoteAgentSessions?.();
    },
    async stop() {
      stopPromise ??= (async () => {
        unsubscribeNodeList?.();
        unsubscribeNodeList = undefined;
        setHealthzTlsProvider(null);
        await tryStop(() => gateway.stopAgentSessions?.(), 'agent-supervisor');
        await tryStop(() => mesh?.stop(), 'mesh');
        await tryStop(() => authHttp?.stop(), 'auth');
        await tryStop(() => hub?.stop(), 'hub');
        await tryStop(() => gateway.stop(), 'gateway');
      })();
      return stopPromise;
    },
    setProcessShutdown(run) {
      processShutdown = run;
    },
    isRestartRequested() {
      return restartRequested;
    },
  };
}

type ShutdownHooks = {
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  exit?: (code: number) => void;
  timeoutMs?: number;
};

export function createProcessShutdown(
  stop: () => Promise<void>,
  hooks: ShutdownHooks = {}
): () => Promise<void> {
  const exit = hooks.exit ?? ((code) => process.exit(code));
  const timeoutMs = hooks.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  let promise: Promise<void> | null = null;
  return () => {
    if (promise) return promise;
    promise = new Promise<void>((resolve) => {
      let finished = false;
      const timer = setTimeout(() => done(1), timeoutMs);
      function done(code: number) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        exit(code);
        resolve();
      }
      void Promise.resolve()
        .then(stop)
        .then(
          () => done(0),
          () => done(1)
        );
    });
    return promise;
  };
}

export function installShutdownHandlers(
  stop: () => Promise<void>,
  hooks: ShutdownHooks = {}
): () => Promise<void> {
  const on =
    hooks.on ??
    ((event, listener) => {
      process.on(event as NodeJS.Signals, listener as NodeJS.SignalsListener);
    });
  const run = createProcessShutdown(stop, hooks);
  const handler = () => void run();
  on('SIGINT', handler);
  on('SIGTERM', handler);
  return run;
}
