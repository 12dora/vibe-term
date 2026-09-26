import type { ShareScope } from '@vibeterm/shared/share';
import {
  restoreRemoteAgentSessionsIfLoaded,
  startAgentSupervisor,
  stopAgentSupervisorIfLoaded,
} from './agent/lazy';
import { type SystemApiHandler, handleApiRequest } from './api';
import { json } from './api/http';
import { startGatewaySweepers, stopGatewaySweepers } from './auth/login-records-runtime';
import type { AuthDb } from './auth/types';
import { config, isRelayOnly, resolveLiveRoles } from './config';
import { runtimeController } from './control/runtime';
import {
  ensureDefaultLocalDeviceSeeded,
  ensureSiteSettingsInitialized,
  getSiteSettings,
} from './db';
import { ensureAgentSettingsInitialized } from './db/agent';
import { getDb as getOrmDb } from './db/client';
import { runMigrations } from './db/migrate';
import { eventNotifier } from './events';
import { registerEventNotifyBroadcaster } from './events/broadcaster';
import { sweepOrphanTransferTemps } from './files/transfer-session';
import { t } from './i18n';
import { logMemoryProfileOnce } from './memory-profile';
import { type DispatchContext, requestDispatchContext } from './mesh/types';
import { registerMessagingRuntime, resetMessagingRuntime } from './messaging/context';
import { createMessagingRuntimeHooks, setMessagingMeshRuntime } from './messaging/runtime-hooks';
import { startPortMaps, stopPortMaps } from './portmap/manager';
import { connectionAlertNotifier } from './push/connection-alerts';
import { pushSupervisor } from './push/supervisor';
import { registerSettingsBroadcaster, registerTreeOverlayBridge } from './settings/broadcaster';
import {
  loadTelegramService,
  refreshTelegramService,
  stopTelegramServiceIfLoaded,
} from './telegram/lazy';
import { tmuxRuntimeRegistry } from './tmux-client/registry';
import { primeLocalShellPath } from './tmux/local-shell-path';
import { registerSnapshotLookup } from './tmux/snapshot-directory';
import { startTunnelManager, stopTunnelManagerIfLoaded } from './tunnel/lazy';
import { startWatchService, stopWatchServiceIfLoaded } from './watch/lazy';
import { loadWeixinService, refreshWeixinService, stopWeixinServiceIfLoaded } from './weixin/lazy';
import { WebSocketServer } from './ws';
import { startGatewayEventLoopLag, stopGatewayEventLoopLag } from './ws/event-loop-lag';
import type { GatewaySocketData } from './ws/types';
import { GATEWAY_WS_BACKPRESSURE_HARD_LIMIT_BYTES } from './ws/websocket-send-guard';

interface GatewayRuntimeOptions {
  runMigrationsOnStart?: boolean;
  initializeSiteSettings?: boolean;
  migrationsFolder?: string;
  systemApiHandler?: SystemApiHandler;
  mode?: 'normal' | 'preflight';
  runMigrationsFn?: (folder?: string) => void;
  liveStart?: () => Promise<void>;
}

/** 分享连接以只读的 window 作用域开启会话；常规连接不带该项。 */
export type GatewayOpenOptions = { shareScope?: ShareScope };

export interface GatewayRuntime {
  readonly port: number;
  readonly db: AuthDb;
  readonly wsServer: WebSocketServer;
  handleRequest: (
    req: Request,
    bunServer: Bun.Server<unknown>
  ) => Response | Promise<Response> | undefined;
  dispatchHttp: (request: Request, ctx: DispatchContext) => Promise<Response>;
  websocket: {
    backpressureLimit: number;
    closeOnBackpressureLimit: boolean;
    open: (ws: Bun.ServerWebSocket<unknown>, opts?: GatewayOpenOptions) => void;
    message: (ws: Bun.ServerWebSocket<unknown>, message: string | Buffer) => void;
    drain: (ws: Bun.ServerWebSocket<unknown>) => void;
    close: (ws: Bun.ServerWebSocket<unknown>, code: number, reason: string) => void;
    closeSession: (session: GatewaySocketData['session'], code: number, reason: string) => void;
  };
  onRestartRequested: (listener: () => Promise<void> | void) => void;
  restoreRemoteAgentSessions?: () => void;
  stopAgentSessions?: () => Promise<void>;
  stop: () => Promise<void>;
}

function noopWebsocket(): GatewayRuntime['websocket'] {
  return {
    backpressureLimit: GATEWAY_WS_BACKPRESSURE_HARD_LIMIT_BYTES,
    closeOnBackpressureLimit: true,
    open() {},
    message() {},
    drain() {},
    close() {},
    closeSession() {},
  };
}

export type LiveGatewayStartDeps = {
  roles?: ReturnType<typeof resolveLiveRoles>;
  startLag?: () => void;
  refreshTelegram?: () => Promise<void>;
  refreshWeixin?: () => Promise<void>;
  startPush?: () => Promise<void>;
  startAgent?: () => Promise<void>;
  startWatch?: () => Promise<void>;
  startTunnel?: () => Promise<void>;
  sendOnline?: () => Promise<void>;
};

async function sendGatewayOnlineMessages(): Promise<void> {
  try {
    const settings = getSiteSettings();
    const [{ telegramService }, { weixinService }] = await Promise.all([
      loadTelegramService(),
      loadWeixinService(),
    ]);
    await telegramService.sendGatewayOnlineMessage(settings.siteName);
    await weixinService.sendGatewayOnlineMessage(settings.siteName);
  } catch (err) {
    console.error('[gateway] failed to push startup message:', err);
  }
}

export function shouldStartMessagingServices(
  roles: ReturnType<typeof resolveLiveRoles> = resolveLiveRoles()
): boolean {
  return !isRelayOnly(roles);
}

export async function startLiveGatewayServices(deps: LiveGatewayStartDeps = {}): Promise<void> {
  const messaging = shouldStartMessagingServices(deps.roles ?? resolveLiveRoles());
  (deps.startLag ?? startGatewayEventLoopLag)();
  registerMessagingRuntime(createMessagingRuntimeHooks());
  if (!messaging) return;
  await (deps.refreshTelegram ?? refreshTelegramService)();
  await (deps.refreshWeixin ?? refreshWeixinService)();
  await (deps.startPush ?? (() => pushSupervisor.start()))();
  await (deps.startAgent ?? startAgentSupervisor)();
  await (deps.startWatch ?? startWatchService)();
  await (deps.startTunnel ?? startTunnelManager)();
  startPortMaps();
  await (deps.sendOnline ?? sendGatewayOnlineMessages)();
}

async function stopGatewayLiveServices(): Promise<void> {
  stopGatewayEventLoopLag();
  resetMessagingRuntime();
  setMessagingMeshRuntime(null);
  connectionAlertNotifier.setBroadcaster(null);
  connectionAlertNotifier.setEventEmitter(null);
  registerSettingsBroadcaster(null);
  registerEventNotifyBroadcaster(null);
  registerTreeOverlayBridge(null);
  stopPortMaps();
  await stopTunnelManagerIfLoaded();
  await stopWatchServiceIfLoaded();
  await stopAgentSupervisorIfLoaded();
  await pushSupervisor.stopAll();
  await tmuxRuntimeRegistry.shutdownAll();
  await stopTelegramServiceIfLoaded();
  await stopWeixinServiceIfLoaded();
}

function createPreflightGatewayRuntime(options: GatewayRuntimeOptions): GatewayRuntime {
  const wsServer = new WebSocketServer();
  const db = getOrmDb();
  return {
    port: config.port,
    db,
    wsServer,
    handleRequest() {
      return undefined;
    },
    async dispatchHttp() {
      return json({ error: t('apiError.notFound') }, 404);
    },
    websocket: noopWebsocket(),
    onRestartRequested() {},
    restoreRemoteAgentSessions() {},
    stopAgentSessions: async () => undefined,
    async stop() {},
  };
}

/**
 * 启动时清空发行包缓存：此刻没有任何下载在途，留着只会一版一版堆到几百 MB。
 * 必须 await——不然它会和启动后第一个升级请求的下载重叠，把刚落盘的包扫掉；清理很快，失败不挡启动。
 */
async function sweepReleaseCacheOnStartup(): Promise<void> {
  try {
    const { getInstallInfo } = await import('./system/install-info');
    const { resolveUpgradeInstallDir } = await import('./system/upgrade');
    const { legacyTmpReleaseCacheDir, resolveReleaseCacheDir, sweepReleaseCache } = await import(
      './system/release-download'
    );
    await sweepReleaseCache(resolveReleaseCacheDir(resolveUpgradeInstallDir(getInstallInfo())), {
      keepVersions: [],
      partTtlMs: 0,
    });
    // 改名前留在 /tmp 的缓存目录整个清掉（目录已不再使用）。
    const { rm } = await import('node:fs/promises');
    await rm(legacyTmpReleaseCacheDir(), { recursive: true, force: true }).catch(() => {});
  } catch {
    // 清理失败不该挡住启动
  }
}

export async function createGatewayRuntime(
  options: GatewayRuntimeOptions = {}
): Promise<GatewayRuntime> {
  const {
    runMigrationsOnStart = true,
    initializeSiteSettings = true,
    migrationsFolder,
    systemApiHandler,
  } = options;
  const mode =
    options.mode ?? (process.env.VIBETERM_RUNTIME_MODE === 'preflight' ? 'preflight' : 'normal');
  const applyMigrations = options.runMigrationsFn ?? runMigrations;
  const liveStart = options.liveStart ?? startLiveGatewayServices;

  if (runMigrationsOnStart) {
    applyMigrations(migrationsFolder);
  }

  if (mode === 'preflight') {
    return createPreflightGatewayRuntime(options);
  }

  if (initializeSiteSettings) {
    // 必须先于 ensureSiteSettingsInitialized：全新库判定依赖 site_settings 尚无行
    ensureDefaultLocalDeviceSeeded();
    ensureSiteSettingsInitialized();
    ensureAgentSettingsInitialized();
  }

  runtimeController.reset();
  primeLocalShellPath();
  sweepOrphanTransferTemps();
  logMemoryProfileOnce(config.memoryProfile);
  await sweepReleaseCacheOnStartup();

  const wsServer = new WebSocketServer();
  const db = getOrmDb();
  wsServer.currentTheme = getSiteSettings().theme;
  connectionAlertNotifier.setBroadcaster((deviceId, payload) => {
    wsServer.broadcastDeviceError(deviceId, payload);
  });
  connectionAlertNotifier.setEventEmitter((eventType, event) =>
    eventNotifier.notify(eventType, event)
  );
  registerSnapshotLookup((deviceId) => wsServer.getLastSnapshot(deviceId));
  registerSettingsBroadcaster((namespace) => wsServer.broadcastSettingsUpdate(namespace));
  registerEventNotifyBroadcaster((eventType, event) =>
    wsServer.broadcastEventNotify(eventType, event)
  );
  registerTreeOverlayBridge({
    reorderWindows: (deviceId, windowIds) => wsServer.reorderWindows(deviceId, windowIds),
    reorderPanes: (deviceId, windowId, paneIds) =>
      wsServer.reorderPanes(deviceId, windowId, paneIds),
    renameWindow: (deviceId, windowId, name) => wsServer.renameWindow(deviceId, windowId, name),
    renamePane: (deviceId, paneId, name) => wsServer.renamePane(deviceId, paneId, name),
    getCustomNames: (deviceId) => wsServer.getCustomNames(deviceId),
  });
  startGatewaySweepers();
  await liveStart();

  return {
    port: config.port,
    db,
    wsServer,
    handleRequest(req, bunServer) {
      const url = new URL(req.url);

      if (url.pathname === '/ws') {
        const result = wsServer.handleUpgrade(req, bunServer);
        if (result === false) {
          return new Response('Not Found', { status: 404 });
        }
        if (result instanceof Response) {
          return result;
        }
        return undefined;
      }

      if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
        return handleApiRequest(req, bunServer, systemApiHandler);
      }

      return undefined;
    },
    async dispatchHttp(request, ctx) {
      requestDispatchContext.set(request, ctx);
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
        return handleApiRequest(request, undefined, systemApiHandler);
      }
      return json({ error: t('apiError.notFound') }, 404);
    },
    websocket: {
      backpressureLimit: GATEWAY_WS_BACKPRESSURE_HARD_LIMIT_BYTES,
      closeOnBackpressureLimit: true,
      open(ws, opts) {
        wsServer.handleOpen(ws as Bun.ServerWebSocket<GatewaySocketData>, opts);
      },
      message(ws, message) {
        wsServer.handleMessage(ws as Bun.ServerWebSocket<GatewaySocketData>, message);
      },
      drain(ws) {
        const data = (ws as Bun.ServerWebSocket<GatewaySocketData>).data;
        if (!data?.session || data.session.closed) return;
        wsServer.handleDrain(data.session, data.carrier);
      },
      close(ws, code, reason) {
        const data = (ws as Bun.ServerWebSocket<GatewaySocketData>).data;
        if (!data?.session || !data.carrier) return;
        wsServer.handleCarrierClose(data.session, data.carrier, code, reason);
      },
      closeSession(session, code, reason) {
        wsServer.closeSession(session, code, reason);
      },
    },
    onRestartRequested(listener) {
      runtimeController.onRestart(listener);
    },
    restoreRemoteAgentSessions() {
      restoreRemoteAgentSessionsIfLoaded();
    },
    stopAgentSessions() {
      return stopAgentSupervisorIfLoaded();
    },
    async stop() {
      wsServer.closeAll();
      await stopGatewaySweepers();
      await stopGatewayLiveServices();
    },
  };
}
