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
  };
  onRestartRequested: (listener: () => Promise<void> | void) => void;
  stop: () => Promise<void>;
}

const RUNTIME_RESTART_CLOSE_CODE = 1012;
const RUNTIME_RESTART_CLOSE_REASON = 'Gateway runtime restarting';

function armRestart(runtime: ManagedGatewayRuntime): Promise<void> {
  return new Promise<void>((resolve) => {
    runtime.onRestartRequested(resolve);
  });
}

function closeRuntimeWebSockets(
  socketOwners: Map<Bun.ServerWebSocket<unknown>, ManagedGatewayRuntime>,
  runtime: ManagedGatewayRuntime
): unknown {
  let firstError: unknown;
  for (const [ws, owner] of socketOwners) {
    if (owner !== runtime) continue;
    socketOwners.delete(ws);
    try {
      owner.websocket.close(ws, RUNTIME_RESTART_CLOSE_CODE, RUNTIME_RESTART_CLOSE_REASON);
    } catch (error) {
      firstError ??= error;
    }
    try {
      ws.close(RUNTIME_RESTART_CLOSE_CODE, RUNTIME_RESTART_CLOSE_REASON);
    } catch (error) {
      firstError ??= error;
    }
  }
  return firstError;
}

async function retireRuntime(
  socketOwners: Map<Bun.ServerWebSocket<unknown>, ManagedGatewayRuntime>,
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
  const socketOwners = new Map<Bun.ServerWebSocket<unknown>, ManagedGatewayRuntime>();
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
          socketOwners.set(ws, runtime);
          runtime.websocket.open(ws);
        },
        message(ws, message) {
          const runtime = socketOwners.get(ws);
          if (!runtime) {
            ws.close(RUNTIME_RESTART_CLOSE_CODE, RUNTIME_RESTART_CLOSE_REASON);
            return;
          }
          runtime.websocket.message(ws, message);
        },
        drain(ws) {
          socketOwners.get(ws)?.websocket.drain(ws);
        },
        close(ws, code, reason) {
          const runtime = socketOwners.get(ws);
          socketOwners.delete(ws);
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

const managedArgs = parseManagedGatewayArgs(process.argv.slice(2));

if (managedArgs.version) {
  console.log(`tmex-gateway ${embeddedVersion()}`);
} else {
  applyManagedTmuxNamespace(process.env, managedArgs.tmuxNamespace);
  await runManagedGateway();
}
