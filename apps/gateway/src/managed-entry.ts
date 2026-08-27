/**
 * Companion-managed Gateway 入口。
 *
 * 与默认 `index.ts` 分离：在 import 业务模块前锁定 management_mode / update_owner，
 * 保证用户 env 与 API 不能触发自更新。API-only：不挂载 frontend dist。
 *
 * 构建：`bun scripts/build-managed.ts`（`bun build --compile`）。
 */

import { formatHttpEndpoint } from '../../../packages/shared/src/network';
import { applyManagedTmuxNamespace, parseManagedGatewayArgs } from './managed-args';
import type { GatewaySession } from './ws/gateway-session';
import type { GatewaySocketData } from './ws/types';

declare const TMEX_MONOREPO_VERSION: string | undefined;

interface ManagedGatewayRuntime {
  handleRequest: (
    req: Request,
    bunServer: Bun.Server<unknown>
  ) => Response | Promise<Response> | undefined;
  websocket: {
    backpressureLimit: number;
    closeOnBackpressureLimit: boolean;
    open: (ws: Bun.ServerWebSocket<unknown>) => void;
    message: (ws: Bun.ServerWebSocket<unknown>, message: string | Buffer) => void;
    drain: (ws: Bun.ServerWebSocket<unknown>) => void;
    close: (ws: Bun.ServerWebSocket<unknown>, code: number, reason: string) => void;
    closeSession: (session: GatewaySession, code: number, reason: string) => void;
  };
  onRestartRequested: (listener: () => Promise<void> | void) => void;
  stop: () => Promise<void>;
}

type RuntimeSessionCloser = {
  websocket: {
    closeSession: (session: GatewaySession, code: number, reason: string) => void;
  };
};

export const RUNTIME_RESTART_CLOSE_CODE = 1012;
export const RUNTIME_RESTART_CLOSE_REASON = 'Gateway runtime restarting';

function armRestart(runtime: ManagedGatewayRuntime): Promise<void> {
  return new Promise<void>((resolve) => {
    runtime.onRestartRequested(resolve);
  });
}

function socketSession(ws: Bun.ServerWebSocket<unknown>): GatewaySession | undefined {
  return (ws as Bun.ServerWebSocket<GatewaySocketData>).data?.session;
}

export function closeRuntimeWebSockets(
  socketOwners: Map<GatewaySession, RuntimeSessionCloser>,
  runtime: RuntimeSessionCloser
): unknown {
  let firstError: unknown;
  for (const [session, owner] of socketOwners) {
    if (owner !== runtime) continue;
    socketOwners.delete(session);
    try {
      owner.websocket.closeSession(
        session,
        RUNTIME_RESTART_CLOSE_CODE,
        RUNTIME_RESTART_CLOSE_REASON
      );
    } catch (error) {
      firstError ??= error;
    }
  }
  return firstError;
}

async function retireRuntime(
  socketOwners: Map<GatewaySession, ManagedGatewayRuntime>,
  runtime: ManagedGatewayRuntime
): Promise<void> {
  const socketError = closeRuntimeWebSockets(socketOwners, runtime);
  let stopError: unknown;
  try {
    await runtime.stop();
  } catch (error) {
    stopError = error;
  }
  if (socketError !== undefined) {
    throw socketError;
  }
  if (stopError !== undefined) {
    throw stopError;
  }
}

function runtimeUnavailableResponse(): Response {
  return new Response('Gateway runtime unavailable', {
    status: 503,
    headers: { 'retry-after': '1' },
  });
}

function embeddedVersion(): string {
  if (typeof TMEX_MONOREPO_VERSION === 'string' && TMEX_MONOREPO_VERSION) {
    return TMEX_MONOREPO_VERSION;
  }
  return 'unknown';
}

async function runManagedGateway(): Promise<void> {
  const { lockManagedRuntime } = await import('./system/managed');
  lockManagedRuntime({
    managementMode: 'companion-cli',
    updateOwner: 'companion',
  });

  Reflect.deleteProperty(process.env, 'TMEX_FE_DIST_DIR');

  const { consumeManagedEndpointPublication, publishManagedEndpoint, resolveManagedEndpointHost } =
    await import('./system/managed-endpoint');
  const publication = consumeManagedEndpointPublication();

  const [
    { handleManagedSystemApiRequest },
    { config },
    { materializeManagedMigrations },
    { createGatewayRuntime },
    { getDisplayVersion, getManagementMode, getUpdateOwner },
  ] = await Promise.all([
    import('./api/system-managed'),
    import('./config'),
    import('./db/managed-migrations'),
    import('./runtime'),
    import('./system/info-public'),
  ]);

  const managedHost = resolveManagedEndpointHost(config.bindHost);
  if (config.port !== 0) {
    throw new Error('managed Gateway requires GATEWAY_PORT=0');
  }

  console.log(
    `[gateway] tmex ${getDisplayVersion()} managed=${getManagementMode()} owner=${getUpdateOwner()}`
  );

  const createRuntime = async (): Promise<ManagedGatewayRuntime> => {
    const migrations = await materializeManagedMigrations();
    return createGatewayRuntime({
      migrationsFolder: migrations.path,
      systemApiHandler: handleManagedSystemApiRequest,
    }).finally(migrations.cleanup);
  };

  let activeRuntime: ManagedGatewayRuntime | null = await createRuntime();
  let restartRequested = armRestart(activeRuntime);
  const socketOwners = new Map<GatewaySession, ManagedGatewayRuntime>();
  const initialWebSocket = activeRuntime.websocket;
  let server: Bun.Server<unknown> | null = null;

  try {
    server = Bun.serve<unknown>({
      hostname: managedHost,
      port: config.port,
      idleTimeout: 255,
      fetch(req, bunServer) {
        const runtime = activeRuntime;
        if (!runtime) {
          return runtimeUnavailableResponse();
        }
        const response = runtime.handleRequest(req, bunServer);
        if (response !== undefined) {
          return response;
        }
        return new Response('Not Found', { status: 404 });
      },
      websocket: {
        backpressureLimit: initialWebSocket.backpressureLimit,
        closeOnBackpressureLimit: initialWebSocket.closeOnBackpressureLimit,
        open(ws) {
          const runtime = activeRuntime;
          if (!runtime) {
            ws.close(RUNTIME_RESTART_CLOSE_CODE, RUNTIME_RESTART_CLOSE_REASON);
            return;
          }
          runtime.websocket.open(ws);
          const session = socketSession(ws);
          if (session) {
            socketOwners.set(session, runtime);
          }
        },
        message(ws, message) {
          const session = socketSession(ws);
          const runtime = session ? socketOwners.get(session) : undefined;
          if (!runtime) {
            ws.close(RUNTIME_RESTART_CLOSE_CODE, RUNTIME_RESTART_CLOSE_REASON);
            return;
          }
          runtime.websocket.message(ws, message);
        },
        drain(ws) {
          const session = socketSession(ws);
          if (!session) return;
          socketOwners.get(session)?.websocket.drain(ws);
        },
        close(ws, code, reason) {
          const session = socketSession(ws);
          const runtime = session ? socketOwners.get(session) : undefined;
          if (session) socketOwners.delete(session);
          runtime?.websocket.close(ws, code, reason);
        },
      },
    });

    const actualPort = server.port;
    if (actualPort === undefined) {
      throw new Error('managed Gateway TCP listener did not expose an actual port');
    }
    const ready = await publishManagedEndpoint(publication, {
      host: managedHost,
      port: actualPort,
    });
    console.log(`[gateway] listening on ${formatHttpEndpoint(ready.host, ready.port)}`);

    while (true) {
      await restartRequested;
      const previousRuntime = activeRuntime;
      if (!previousRuntime) {
        throw new Error('managed Gateway restart requested without an active runtime');
      }

      activeRuntime = null;
      await retireRuntime(socketOwners, previousRuntime);

      const replacementRuntime = await createRuntime();
      const replacementRestart = armRestart(replacementRuntime);
      activeRuntime = replacementRuntime;
      restartRequested = replacementRestart;
    }
  } finally {
    let cleanupError: unknown;
    const remainingRuntime = activeRuntime;
    activeRuntime = null;
    if (remainingRuntime) {
      try {
        await retireRuntime(socketOwners, remainingRuntime);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (server) {
      try {
        await server.stop(true);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError !== undefined) {
      console.error('[gateway] managed cleanup failed:', cleanupError);
    }
  }
}

if (import.meta.main) {
  const managedArgs = parseManagedGatewayArgs(process.argv.slice(2));

  if (managedArgs.version) {
    console.log(`tmex-gateway ${embeddedVersion()}`);
  } else {
    applyManagedTmuxNamespace(process.env, managedArgs.tmuxNamespace);
    await runManagedGateway();
  }
}
