import { resolve } from 'node:path';
import { PROCESS_STARTED_AT } from '../../../../apps/gateway/src/api/system-routes';
import { NodeIdentityStore } from '../../../../apps/gateway/src/auth/node-identity-store';
import {
  type TmexRoles,
  config as gatewayConfig,
  parseTmexRoles,
} from '../../../../apps/gateway/src/config';
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
import { TlsConfigStore } from '../../../../apps/gateway/src/tls/tls-config-store';
import type { GatewaySession } from '../../../../apps/gateway/src/ws/gateway-session';
import { readNodeEnv } from '../../../../packages/shared/src/env/load-env';
import { disableDirect, enableDirect } from '../commands/direct';
import { performHubJoin } from '../commands/hub';
import { createAuthContextFromDb } from '../lib/local-auth';
import { loadNodeDatachannel } from '../lib/native-datachannel';
import { detectCurrentNativePin } from '../lib/native-manifest';
import { isStandaloneRoles } from '../lib/roles';
import { AcmeHttp01Challenge } from '../tls/acme-challenge';
import { HttpsListener } from '../tls/https-listener';
import { TlsService } from '../tls/tls-service';
import { createTmexGatewayRuntime } from './gateway';
import { jsonErr } from './http';
import { type LocalRouteDeps, handleLocalRequest } from './local-routes';
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
  createGatewayRuntime?: () => Promise<GatewayRuntime>;
  createMeshRuntime?: (opts: CreateMeshRuntimeOptions) => Promise<MeshRuntime>;
  serveFrontend?: (req: Request, staticRoot: string) => Promise<Response>;
  hub?: HubRuntime;
  loadNative?: LoadNative;
  nativeDir?: string;
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

async function meshHttp(
  mesh: MeshRuntime | null,
  req: Request,
  server: Bun.Server<unknown>
): Promise<HttpResult> {
  const path = new URL(req.url).pathname;
  if (!mesh) {
    return path === '/api/auth/mode' && req.method === 'GET'
      ? Response.json({ mode: 'none' })
      : null;
  }
  if (path.startsWith('/api/')) {
    const blocked = mesh.localUiGuard(req);
    if (blocked) return blocked;
  }
  if (path === '/ws' || path === '/n/self/ws' || path === `/n/${mesh.nodeId}/ws`) {
    const wsGuard = mesh.guardGatewayWebSocket(req, server);
    if (wsGuard !== null) return wsGuard ?? undefined;
  }
  const meshResp = await mesh.handleRequest(req, server);
  if (isMeshRewritten(meshResp) || meshResp == null) return meshResp;
  const next =
    path === '/healthz' && req.method === 'GET' ? await attachStartedAt(meshResp) : meshResp;
  return applyLocalRenewal(req, next);
}

async function gatewayHttp(
  gateway: GatewayRuntime,
  mesh: MeshRuntime | null,
  req: Request,
  server: Bun.Server<unknown>
): Promise<HttpResult> {
  const gatewayResp = await gateway.handleRequest(req, server);
  if (gatewayResp instanceof Response)
    return mesh ? applyLocalRenewal(req, gatewayResp) : gatewayResp;
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
  mesh: MeshRuntime | null,
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

function buildTlsLifecycle(
  fetch: AssembledTmex['fetch'],
  websocket: GatewayRuntime['websocket'],
  db: GatewayRuntime['db'],
  routeDeps: LocalRouteDeps,
  tlsSlot: { service?: TlsService }
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
  });
  tlsSlot.service = tls;
  return {
    tls,
    httpsListener,
    tlsHandler: createTlsRoutes({
      service: tls,
      authorize: async (req) =>
        isStandaloneRoles(routeDeps.roles) || routeDeps.authenticate(req).ok
          ? null
          : jsonErr('UNAUTHORIZED', 'login required', 401),
    }),
  };
}

export async function assembleTmex(opts: AssembleTmexOptions = {}): Promise<AssembledTmex> {
  const roles = opts.roles ?? parseTmexRoles(process.env.TMEX_ROLES);
  const staticRoot = opts.staticRoot ?? defaultStaticRoot();
  const createGateway = opts.createGatewayRuntime ?? createTmexGatewayRuntime;
  const createMesh = opts.createMeshRuntime ?? createMeshRuntime;
  const serveFrontend = opts.serveFrontend ?? defaultServeFrontend;
  const gateway = await createGateway();
  const tlsSlot: { service?: TlsService } = {};

  let mesh: MeshRuntime | null = null;
  if (roles.node) {
    const nativeDir = opts.nativeDir ?? process.env.TMEX_NATIVE_DIR ?? '';
    mesh = await createMesh({
      db: gateway.db,
      gateway,
      config: {
        roles,
        hubUrl: gatewayConfig.hubUrl,
        hubPublicUrl: gatewayConfig.hubPublicUrl,
        peerPort: gatewayConfig.peerPort,
        stunServers: gatewayConfig.stunServers,
        turnUrl: gatewayConfig.turnUrl,
        turnUsername: gatewayConfig.turnUsername,
        turnCredential: gatewayConfig.turnCredential,
        bindHost: process.env.TMEX_BIND_HOST || '127.0.0.1',
        peerBindHost: gatewayConfig.peerBindHost,
      },
      hub: opts.hub,
      loadNative:
        opts.loadNative ??
        (async () =>
          process.env.TMEX_DIRECT_ENABLED === 'false' || !nativeDir
            ? null
            : loadNodeDatachannel({ nativeDir })),
      userId: (await new NodeIdentityStore(gateway.db).load())?.userId ?? undefined,
      tlsInfo: async () => ({
        caFingerprint: tlsSlot.service ? (await tlsSlot.service.status()).caFingerprint : null,
        caPem: (await tlsSlot.service?.caPem()) ?? null,
      }),
    });
  }

  const hub = mesh?.hub ?? opts.hub ?? null;
  const auth = await createAuthContextFromDb(gateway.db, {
    installDir: resolveGatewayInstallDir(),
    envPath: resolveSetupEnvPath(),
    env: {
      TMEX_ROLES: process.env.TMEX_ROLES ?? '',
      TMEX_HUB_URL: process.env.TMEX_HUB_URL ?? '',
      TMEX_HUB_PUBLIC_URL: process.env.TMEX_HUB_PUBLIC_URL ?? '',
    },
  });

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
    authenticate: (req) => {
      try {
        return authenticateRequest(req, { roles, nodeSessionStore: auth.nodeSessionStore });
      } catch {
        return { ok: false };
      }
    },
    tlsStatus: async () => {
      if (!tlsSlot.service) throw new Error('tls service is not initialized');
      const status = await tlsSlot.service.status();
      return {
        mode: status.mode,
        listenerRunning: status.listener.running,
        tlsPort: status.tlsPort,
      };
    },
  };

  let tlsHandler: (req: Request) => Promise<Response | null> = async () => null;
  const fetch = createHttpDispatch([
    (req) => tlsHandler(req),
    (req) => handleLocalRequest(req, routeDeps),
    (req) => handleSetupRequest(req, routeDeps),
    (req, server) =>
      hub ? hub.handleRequest(req, server).then((r) => (r instanceof Response ? r : null)) : null,
    (req, server) => meshHttp(mesh, req, server),
    (req, server) => gatewayHttp(gateway, mesh, req, server),
    (req) => serveFrontend(req, staticRoot),
  ]);
  const websocket = routeWebsocket(gateway, mesh, hub);
  const tlsLife = buildTlsLifecycle(fetch, websocket, gateway.db, routeDeps, tlsSlot);
  tlsHandler = tlsLife.tlsHandler;

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
    },
    async stop() {
      stopPromise ??= (async () => {
        await tryStop(() => mesh?.stop(), 'mesh');
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
