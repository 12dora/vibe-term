/**
 * Companion-managed Gateway 入口。
 *
 * 与默认 `index.ts` 分离：在 import 业务模块前锁定 management_mode / update_owner，
 * 保证用户 env 与 API 不能触发自更新。API-only：不挂载 frontend dist。
 *
 * 构建：`bun scripts/build-managed.ts`（`bun build --compile`）。
 */

export {};

declare const TMEX_MONOREPO_VERSION: string | undefined;

interface RunningRuntime {
  stop: () => Promise<void>;
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

  console.log(
    `[gateway] tmex ${getDisplayVersion()} managed=${getManagementMode()} owner=${getUpdateOwner()}`
  );
  while (true) {
    const migrations = await materializeManagedMigrations();
    const gateway: RunningRuntime & {
      handleRequest: (
        req: Request,
        bunServer: Bun.Server<unknown>
      ) => Response | Promise<Response> | undefined;
      websocket: {
        open: (ws: Bun.ServerWebSocket<unknown>) => void;
        message: (ws: Bun.ServerWebSocket<unknown>, message: string | Buffer) => void;
        close: (ws: Bun.ServerWebSocket<unknown>) => void;
      };
      onRestartRequested: (listener: () => Promise<void> | void) => void;
    } = await createGatewayRuntime({
      migrationsFolder: migrations.path,
      systemApiHandler: handleManagedSystemApiRequest,
    }).finally(migrations.cleanup);

    const server = Bun.serve({
      hostname: config.bindHost,
      port: config.port,
      idleTimeout: 255,
      async fetch(req, bunServer) {
        const response = gateway.handleRequest(req, bunServer);
        if (response !== undefined) {
          return response;
        }
        return new Response('Not Found', { status: 404 });
      },
      websocket: gateway.websocket,
    });

    console.log(`[gateway] listening on ${config.bindHost}:${config.port}`);

    await new Promise<void>((resolve) => {
      gateway.onRestartRequested(async () => {
        await gateway.stop();
        server.stop(true);
        resolve();
      });
    });
  }
}

if (process.argv.slice(1).includes('--version')) {
  console.log(`tmex-gateway ${embeddedVersion()}`);
} else {
  await runManagedGateway();
}
