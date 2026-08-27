import { resolve } from 'node:path';
import {
  type TmexRoles,
  config as gatewayConfig,
  parseTmexRoles,
} from '../../../../apps/gateway/src/config';
import type { HubRuntime, HubServerWebSocket } from '../../../../apps/gateway/src/hub';
import { MESH_FORWARD_WS_KIND, MESH_WS_KIND } from '../../../../apps/gateway/src/mesh/mesh-deps';
import {
  type CreateMeshRuntimeOptions,
  type MeshRuntime,
  createMeshRuntime,
} from '../../../../apps/gateway/src/mesh/mesh-runtime';
import type { GatewayRuntime } from '../../../../apps/gateway/src/runtime';
import { createTmexGatewayRuntime } from './gateway';
import { serveFrontend as defaultServeFrontend } from './serve-frontend';

export const SHUTDOWN_TIMEOUT_MS = 5_000;

export type AssembleTmexOptions = {
  roles?: TmexRoles;
  staticRoot?: string;
  createGatewayRuntime?: () => Promise<GatewayRuntime>;
  createMeshRuntime?: (opts: CreateMeshRuntimeOptions) => Promise<MeshRuntime>;
  serveFrontend?: (req: Request, staticRoot: string) => Promise<Response>;
  hub?: HubRuntime;
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
  return kind === MESH_WS_KIND || kind === MESH_FORWARD_WS_KIND;
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
      },
      hub: opts.hub,
    });
  }

  const hub = mesh?.hub ?? opts.hub ?? null;

  const fetch: AssembledTmex['fetch'] = async (req, bunServer) => {
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
      const meshResp = await mesh.handleRequest(req, bunServer);
      if (meshResp instanceof Response) return meshResp;
    }
    const gatewayResp = await gateway.handleRequest(req, bunServer);
    if (gatewayResp instanceof Response) return gatewayResp;
    return serveFrontend(req, staticRoot);
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
        mesh.websocket.open(ws as never);
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
        mesh.websocket.message(ws as never, message);
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
      if (mesh && isMeshKind(kind)) {
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
      if (mesh && isMeshKind(kind)) {
        mesh.websocket.close(ws as never, code, reason);
        return;
      }
      gateway.websocket.close(ws, code, reason);
    },
    closeSession(session, code, reason) {
      gateway.websocket.closeSession(session, code, reason);
    },
  };

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
      await mesh?.stop();
      hub?.stop();
      await gateway.stop();
    },
  };
}

export type ShutdownHooks = {
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  exit?: (code: number) => void;
  timeoutMs?: number;
};

export function installShutdownHandlers(
  stop: () => Promise<void>,
  hooks: ShutdownHooks = {}
): void {
  const on =
    hooks.on ??
    ((event, listener) => {
      process.on(event as NodeJS.Signals, listener as NodeJS.SignalsListener);
    });
  const exit = hooks.exit ?? ((code) => process.exit(code));
  const timeoutMs = hooks.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  let stopping = false;
  const handler = () => {
    if (stopping) return;
    stopping = true;
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      exit(1);
    }, timeoutMs);
    void Promise.resolve()
      .then(stop)
      .then(
        () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          exit(0);
        },
        () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          exit(1);
        }
      );
  };
  on('SIGINT', handler);
  on('SIGTERM', handler);
}
