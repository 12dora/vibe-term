import { resolve } from 'node:path';
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
import { applyLocalRenewal } from '../../../../apps/gateway/src/mesh/session-middleware';
import type { GatewayRuntime } from '../../../../apps/gateway/src/runtime';
import type { GatewaySession } from '../../../../apps/gateway/src/ws/gateway-session';
import { loadNodeDatachannel } from '../lib/native-datachannel';
import { createTmexGatewayRuntime } from './gateway';
import { serveFrontend as defaultServeFrontend } from './serve-frontend';

export const SHUTDOWN_TIMEOUT_MS = 20_000;

export function meshShutdownNeeded(roles: TmexRoles): boolean {
  return roles.hub || roles.node;
}

export type AssembleTmexOptions = {
  roles?: TmexRoles;
  staticRoot?: string;
  createGatewayRuntime?: () => Promise<GatewayRuntime>;
  createMeshRuntime?: (opts: CreateMeshRuntimeOptions) => Promise<MeshRuntime>;
  serveFrontend?: (req: Request, staticRoot: string) => Promise<Response>;
  hub?: HubRuntime;
  loadNative?: LoadNative;
  nativeDir?: string;
};

export type AssembledTmex = {
  roles: TmexRoles;
  gateway: GatewayRuntime;
  mesh: MeshRuntime | null;
  hub: HubRuntime | null;
  fetch: (
    req: Request,
    bunServer: Bun.Server<unknown>
  ) => Response | Promise<Response | undefined> | undefined;
  websocket: GatewayRuntime['websocket'];
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

function defaultStaticRoot(): string {
  if (process.env.TMEX_FE_DIST_DIR) {
    return resolve(process.env.TMEX_FE_DIST_DIR);
  }
  return resolve(import.meta.dir, '../../resources/fe-dist');
}

function socketKind(ws: { data?: unknown }): string | undefined {
  const data = ws.data;
  if (typeof data === 'object' && data !== null && 'kind' in data) {
    const kind = (data as { kind?: unknown }).kind;
    if (typeof kind === 'string') return kind;
  }
  return undefined;
}

function isMeshKind(kind: string | undefined): boolean {
  return (
    kind === MESH_WS_KIND ||
    kind === MESH_FORWARD_WS_KIND ||
    kind === MESH_REJECT_4401_KIND ||
    kind === MESH_GATEWAY_WS_KIND
  );
}

function clientIpFromServer(server: Bun.Server<unknown>, req: Request): string | undefined {
  try {
    const info = server.requestIP(req);
    if (info?.address) return info.address;
  } catch {
    // requestIP is unavailable in some test fakes
  }
  return undefined;
}

function seedLocalContext(req: Request, bunServer: Bun.Server<unknown>): void {
  const existing = getMeshRequestContext(req);
  setMeshRequestContext(req, {
    ...existing,
    via: existing.via || MESH_VIA_SELF,
    clientIp: existing.clientIp ?? clientIpFromServer(bunServer, req),
    trustProxy: gatewayConfig.trustProxy,
  });
}

export async function assembleTmex(opts: AssembleTmexOptions = {}): Promise<AssembledTmex> {
  const roles = opts.roles ?? parseTmexRoles(process.env.TMEX_ROLES);
  const staticRoot = opts.staticRoot ?? defaultStaticRoot();
  const createGateway = opts.createGatewayRuntime ?? createTmexGatewayRuntime;
  const createMesh = opts.createMeshRuntime ?? createMeshRuntime;
  const serveFrontend = opts.serveFrontend ?? defaultServeFrontend;

  const gateway = await createGateway();

  let mesh: MeshRuntime | null = null;
  if (roles.node) {
    const nativeDir = opts.nativeDir ?? process.env.TMEX_NATIVE_DIR ?? '';
    const loadNative: LoadNative =
      opts.loadNative ??
      (async () => {
        if (!nativeDir) return null;
        return loadNodeDatachannel({ nativeDir });
      });
    const identityUserId = (await new NodeIdentityStore(gateway.db).load())?.userId ?? undefined;
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
      loadNative,
      userId: identityUserId,
    });
  }

  const hub = mesh?.hub ?? opts.hub ?? null;

  const dispatch = async (
    req: Request,
    bunServer: Bun.Server<unknown>,
    rewritten: boolean
  ): Promise<Response | undefined> => {
    seedLocalContext(req, bunServer);

    if (hub) {
      const hubResp = await hub.handleRequest(req, bunServer);
      if (hubResp instanceof Response) return hubResp;
    }

    if (mesh) {
      const path = new URL(req.url).pathname;
      if (path.startsWith('/api/')) {
        const blocked = mesh.localUiGuard(req);
        if (blocked) return blocked;
      }
      if (path === '/ws' || path === '/n/self/ws' || path === `/n/${mesh.nodeId}/ws`) {
        const wsGuard = mesh.guardGatewayWebSocket(req, bunServer);
        if (wsGuard !== null) return wsGuard ?? undefined;
      }
      const meshResp = await mesh.handleRequest(req, bunServer);
      if (isMeshRewritten(meshResp) && !rewritten) {
        return dispatch(meshResp.rewritten, bunServer, true);
      }
      if (meshResp instanceof Response) {
        return applyLocalRenewal(req, meshResp);
      }
      if (meshResp === undefined) return undefined;
    } else {
      const path = new URL(req.url).pathname;
      if (path === '/api/auth/mode' && req.method === 'GET') {
        return new Response(JSON.stringify({ mode: 'none' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    const gatewayResp = await gateway.handleRequest(req, bunServer);
    if (gatewayResp instanceof Response) {
      return mesh ? applyLocalRenewal(req, gatewayResp) : gatewayResp;
    }
    if (gatewayResp === undefined && new URL(req.url).pathname === '/ws') {
      return undefined;
    }
    return serveFrontend(req, staticRoot);
  };

  const fetch: AssembledTmex['fetch'] = async (req, bunServer) => {
    return dispatch(req, bunServer, false);
  };

  const websocket: GatewayRuntime['websocket'] = {
    backpressureLimit: gateway.websocket.backpressureLimit,
    closeOnBackpressureLimit: gateway.websocket.closeOnBackpressureLimit,
    open(ws) {
      if (hub?.isUplinkSocket(ws)) {
        hub.handleUplinkOpen(ws as HubServerWebSocket);
        return;
      }
      const kind = socketKind(ws);
      if (mesh && isMeshKind(kind)) {
        const data = ws.data as {
          sid?: string;
          uid?: string;
          via?: string;
          cid?: string;
        };
        const sid = data.sid;
        const uid = data.uid;
        const via = data.via ?? MESH_VIA_SELF;
        mesh.websocket.open(ws as never);
        if (kind === MESH_GATEWAY_WS_KIND) {
          gateway.websocket.open(ws);
          const session = (ws.data as { session?: GatewaySession }).session;
          if (sid && uid && session) {
            const cid = typeof data.cid === 'string' && data.cid.trim() ? data.cid.trim() : '';
            const registered = mesh.registerGatewaySession?.({
              sid,
              uid,
              via,
              session,
              ...(cid ? { cid } : {}),
            });
            if (registered && !registered.ok) {
              gateway.websocket.closeSession(session, WS_CLOSE_LOGIN_REQUIRED, registered.code);
            }
          }
        }
        return;
      }
      gateway.websocket.open(ws);
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
          gateway.websocket.message(ws, message);
          return;
        }
        mesh.websocket.message(ws as never, message);
        return;
      }
      if (mesh && !mesh.touchSocket(ws as never)) {
        return;
      }
      gateway.websocket.message(ws, message);
    },
    drain(ws) {
      if (hub?.isUplinkSocket(ws)) {
        hub.handleUplinkDrain(ws as HubServerWebSocket);
        return;
      }
      const kind = socketKind(ws);
      if (mesh && isMeshKind(kind) && kind !== MESH_GATEWAY_WS_KIND) {
        mesh.websocket.drain(ws as never);
        return;
      }
      gateway.websocket.drain(ws);
    },
    close(ws, code, reason) {
      if (hub?.isUplinkSocket(ws)) {
        hub.handleUplinkClose(ws as HubServerWebSocket, code, reason);
        return;
      }
      const kind = socketKind(ws);
      if (mesh) {
        const session = (ws.data as { session?: GatewaySession }).session;
        if (session) mesh.unregisterGatewaySession?.(session);
        mesh.websocket.close(ws as never, code, reason);
        if (
          kind === MESH_WS_KIND ||
          kind === MESH_FORWARD_WS_KIND ||
          kind === MESH_REJECT_4401_KIND
        ) {
          return;
        }
      }
      gateway.websocket.close(ws, code, reason);
    },
    closeSession(session, code, reason) {
      gateway.websocket.closeSession(session, code, reason);
    },
  };

  let stopPromise: Promise<void> | null = null;

  return {
    roles,
    gateway,
    mesh,
    hub,
    fetch,
    websocket,
    async start() {
      await mesh?.start();
    },
    async stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        try {
          await mesh?.stop();
        } catch (err) {
          console.error('[tmex] mesh stop failed', err);
        }
        try {
          hub?.stop();
        } catch (err) {
          console.error('[tmex] hub stop failed', err);
        }
        try {
          await gateway.stop();
        } catch (err) {
          console.error('[tmex] gateway stop failed', err);
        }
      })();
      return stopPromise;
    },
  };
}

export type ShutdownHooks = {
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
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        exit(1);
        resolve();
      }, timeoutMs);
      void Promise.resolve()
        .then(stop)
        .then(
          () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            exit(0);
            resolve();
          },
          () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            exit(1);
            resolve();
          }
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
  const handler = () => {
    void run();
  };
  on('SIGINT', handler);
  on('SIGTERM', handler);
  return run;
}
