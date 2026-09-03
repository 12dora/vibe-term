import {
  buildDomainAccessView,
  guardDomainAccess,
} from '../../../../apps/gateway/src/api/domain-access-routes';
import { setSiteSettingsLinkProvider } from '../../../../apps/gateway/src/api/site-settings-link';
import {
  PROCESS_STARTED_AT,
  setHealthzTlsProvider,
} from '../../../../apps/gateway/src/api/system-routes';
import type { NodeSessionStore } from '../../../../apps/gateway/src/auth/node-session-store';
import { config as gatewayConfig } from '../../../../apps/gateway/src/config';
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
import type { MeshHttpRuntime } from '../../../../apps/gateway/src/mesh/mesh-http';
import type { MeshRuntime } from '../../../../apps/gateway/src/mesh/mesh-runtime';
import {
  applyLocalRenewal,
  authenticateRequest,
} from '../../../../apps/gateway/src/mesh/session-middleware';
import type { GatewayRuntime } from '../../../../apps/gateway/src/runtime';
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
import type { LocalAuthContext } from '../lib/local-auth';
import { detectCurrentNativePin } from '../lib/native-manifest';
import type { TmexRoles } from '../lib/roles';
import { AcmeHttp01Challenge } from '../tls/acme-challenge';
import { HttpsListener } from '../tls/https-listener';
import { TlsService } from '../tls/tls-service';
import { jsonErr } from './http';
import { type LocalRouteDeps, handleLocalRequest } from './local-routes';
import { handleSetupRequest } from './setup-routes';
import { resolveSetupEnvPath } from './setup-service';
import { createTlsRoutes } from './tls-routes';

export type AssembledFetch = (
  req: Request,
  bunServer: Bun.Server<unknown>
) => Response | Promise<Response | undefined> | undefined;

export type AssembledLifecycle = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  setProcessShutdown: (run: () => Promise<void>) => void;
  isRestartRequested: () => boolean;
};

export type AssembleShutdownState = {
  processShutdown: (() => Promise<void>) | null;
  restartRequested: boolean;
};

type HttpResult = Response | null | undefined | MeshRewritten;
type HttpHandler = (req: Request, server: Bun.Server<unknown>) => HttpResult | Promise<HttpResult>;

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

type TlsHandler = (req: Request) => Promise<Response | null>;

export type HttpAndWs = {
  fetch: AssembledFetch;
  websocket: GatewayRuntime['websocket'];
  setTlsHandler: (handler: TlsHandler) => void;
};

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

export async function tryStop(run: () => unknown, label?: string): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (label) console.error(`[tmex] ${label} stop failed`, err);
  }
}

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

function createHttpDispatch(handlers: HttpHandler[]): AssembledFetch {
  const dispatch = async (
    req: Request,
    bunServer: Bun.Server<unknown>,
    rewritten: boolean
  ): Promise<Response | undefined> => {
    seedLocalContext(req, bunServer);
    if (!rewritten) {
      const denied = await guardEntryAccess(req);
      if (denied) return denied;
      const domainDenied = guardDomainAccess(req);
      if (domainDenied) return domainDenied;
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

export async function advertisedTlsInfo(
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
  fetch: AssembledFetch,
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

export function buildLocalRouteDeps(input: {
  roles: TmexRoles;
  auth: LocalAuthContext;
  mesh: MeshRuntime | null;
  hub: HubRuntime | null;
  tlsSlot: { service?: TlsService };
  scheduleRestart: () => void;
  localAuthEffective: () => boolean;
}): LocalRouteDeps {
  return {
    roles: input.roles,
    nodeEnv: readNodeEnv(),
    auth: input.auth,
    precheckCaPem: async () => (await input.tlsSlot.service?.caPem()) ?? null,
    envPath: input.auth.envPath,
    installDir: input.auth.installDir,
    hubUrl: gatewayConfig.hubUrl,
    hubPublicUrl: gatewayConfig.hubPublicUrl,
    enableDirect,
    disableDirect,
    isDirectSupported: () => detectCurrentNativePin() != null,
    get rtcCapable() {
      return Boolean(input.mesh?.rtc?.available);
    },
    platform: `${process.platform}-${process.arch}`,
    performHubJoin,
    scheduleRestart: input.scheduleRestart,
    quiesceMesh: async () => {
      await tryStop(() => input.mesh?.stop());
      await tryStop(() => input.hub?.stop());
    },
    startedAt: PROCESS_STARTED_AT,
    authenticate: createRouteAuthenticate(
      input.roles,
      input.auth.nodeSessionStore,
      input.localAuthEffective
    ),
    tlsStatus: async () => {
      if (!input.tlsSlot.service) throw new Error('tls service is not initialized');
      const { mode, listener, tlsPort } = await input.tlsSlot.service.status();
      return { mode, listenerRunning: listener.running, tlsPort };
    },
    domainAccess: (req) => buildDomainAccessView(req),
  };
}

export function buildHttpAndWs(input: {
  gateway: GatewayRuntime;
  mesh: MeshRuntime | null;
  hub: HubRuntime | null;
  authHttp: MeshHttpRuntime | null;
  routeDeps: LocalRouteDeps;
  serveFrontend: (req: Request, staticRoot: string) => Promise<Response>;
  staticRoot: string;
}): HttpAndWs {
  const authSurface = input.mesh ?? input.authHttp;
  let tlsHandler: TlsHandler = async () => null;
  const fetch = createHttpDispatch([
    (req) => tlsHandler(req),
    (req) => handleLocalRequest(req, input.routeDeps),
    (req) => handleSetupRequest(req, input.routeDeps),
    (req, server) =>
      input.hub
        ? input.hub.handleRequest(req, server).then((r) => (r instanceof Response ? r : null))
        : null,
    (req, server) => meshHttp(authSurface, req, server),
    (req, server) => gatewayHttp(input.gateway, Boolean(authSurface), req, server),
    (req) => input.serveFrontend(req, input.staticRoot),
  ]);
  const websocket = routeWebsocket(
    input.gateway,
    input.mesh ?? wsAuthFrom(input.authHttp),
    input.hub
  );
  return {
    fetch,
    websocket,
    setTlsHandler(handler) {
      tlsHandler = handler;
    },
  };
}

export function wireTlsLifecycle(input: {
  http: HttpAndWs;
  gateway: GatewayRuntime;
  routeDeps: LocalRouteDeps;
  tlsSlot: { service?: TlsService };
  authHttp: MeshHttpRuntime | null;
  mesh: MeshRuntime | null;
  hub: HubRuntime | null;
}) {
  const invalidateTlsCaches = () => {
    input.authHttp?.auth.invalidateAuthModeCache();
    input.mesh?.invalidateAuthModeCache();
  };
  const refreshMeshTls = () => {
    invalidateTlsCaches();
    void (async () => {
      try {
        const tls = await advertisedTlsInfo(input.tlsSlot.service);
        if (input.hub && typeof input.hub.updateSelfCaFingerprint === 'function') {
          input.hub.updateSelfCaFingerprint(tls.caFingerprint);
        }
      } catch {
        /* fake db in unit tests has no tls_config table */
      }
      await input.mesh?.refreshTlsAndAdvertise();
    })();
  };
  const tlsLife = buildTlsLifecycle(
    input.http.fetch,
    input.http.websocket,
    input.gateway.db,
    input.routeDeps,
    input.tlsSlot,
    {
      onStatusChange: refreshMeshTls,
      onTlsApplied: invalidateTlsCaches,
    }
  );
  input.http.setTlsHandler(tlsLife.tlsHandler);
  void input.mesh?.refreshTlsAndAdvertise();
  setHealthzTlsProvider(async () => {
    const status = await tlsLife.tls.status();
    return { mode: status.mode, listenerRunning: status.listener.running };
  });
  return tlsLife;
}

export function createAssembledLifecycle(input: {
  mesh: MeshRuntime | null;
  gateway: GatewayRuntime;
  authHttp: MeshHttpRuntime | null;
  hub: HubRuntime | null;
  unsubscribeNodeList: (() => void) | undefined;
  shutdown: AssembleShutdownState;
}): AssembledLifecycle {
  let unsubscribe = input.unsubscribeNodeList;
  let stopPromise: Promise<void> | null = null;
  return {
    async start() {
      await input.mesh?.start();
      input.gateway.restoreRemoteAgentSessions?.();
    },
    async stop() {
      stopPromise ??= (async () => {
        unsubscribe?.();
        unsubscribe = undefined;
        setHealthzTlsProvider(null);
        setSiteSettingsLinkProvider(null);
        await tryStop(() => input.gateway.stopAgentSessions?.(), 'agent-supervisor');
        await tryStop(() => input.mesh?.stop(), 'mesh');
        await tryStop(() => input.authHttp?.stop(), 'auth');
        await tryStop(() => input.hub?.stop(), 'hub');
        await tryStop(() => input.gateway.stop(), 'gateway');
      })();
      return stopPromise;
    },
    setProcessShutdown(run) {
      input.shutdown.processShutdown = run;
    },
    isRestartRequested() {
      return input.shutdown.restartRequested;
    },
  };
}
