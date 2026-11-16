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
import { execWebSocketHandlers, isExecWsSocket } from './exec/channel/ws-handlers';
import {
  authenticateOpenExecUpgrade,
  handleExecWsUpgrade,
  isExecWsPath,
} from './exec/channel/ws-upgrade';
import { sweepOrphanTransferTemps } from './files/transfer-session';
import { ensureI18nLocale, t } from './i18n';
import {
  type LiveStartGates,
  defaultLiveStartGates,
  markLiveServicesStopping,
  setLiveServicesEnabled,
} from './live-start-gates';
import { logMemoryProfileOnce } from './memory-profile';
import { type DispatchContext, requestDispatchContext } from './mesh/types';
import { armMessagingHooks, resetMessagingHooksIfLoaded } from './messaging/lazy-hooks';
import {
  startPortMapExportSweeper,
  startPortMapManager,
  stopPortMapsIfLoaded,
} from './portmap/lazy';
import { connectionAlertNotifier } from './push/connection-alerts';
import { pushSupervisor } from './push/supervisor';
import { registerSettingsBroadcaster, registerTreeOverlayBridge } from './settings/broadcaster';
import {
  peekTelegramService,
  refreshTelegramService,
  stopTelegramServiceIfLoaded,
} from './telegram/lazy';
import { tmuxRuntimeRegistry } from './tmux-client/registry';
import { primeLocalShellPath } from './tmux/local-shell-path';
import { registerSnapshotLookup } from './tmux/snapshot-directory';
import { loadTunnelManager, startTunnelManager, stopTunnelManagerIfLoaded } from './tunnel/lazy';
import { startWatchService, stopWatchServiceIfLoaded } from './watch/lazy';
import { peekWeixinService, refreshWeixinService, stopWeixinServiceIfLoaded } from './weixin/lazy';
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
  /** 推送 / bot 文案按站点语言渲染：先把该语言包加载进来。 */
  ensureLocale?: () => Promise<void>;
  refreshTelegram?: () => Promise<void>;
  refreshWeixin?: () => Promise<void>;
  startPush?: () => Promise<void>;
  startAgent?: () => Promise<void>;
  startWatch?: () => Promise<void>;
  startTunnel?: () => Promise<void>;
  /** 纯 relay 下已有隧道配置时只加载（注册 Access 守卫），不 start。 */
  loadTunnel?: () => Promise<void>;
  startExportSweeper?: () => void;
  startPortMaps?: () => Promise<void>;
  sendOnline?: () => Promise<void>;
  gates?: Partial<LiveStartGates>;
};

type ResolvedLiveDeps = Required<Omit<LiveGatewayStartDeps, 'roles' | 'gates'>> & {
  gates: LiveStartGates;
};

/** 只给已加载（即已配置并启动）的 bot 服务发上线消息；未加载时本来也没有在跑的 bot。 */
async function sendGatewayOnlineMessages(): Promise<void> {
  try {
    const settings = getSiteSettings();
    await peekTelegramService()?.telegramService.sendGatewayOnlineMessage(settings.siteName);
    await peekWeixinService()?.weixinService.sendGatewayOnlineMessage(settings.siteName);
  } catch (err) {
    console.error('[gateway] failed to push startup message:', err);
  }
}

export function shouldStartMessagingServices(
  roles: ReturnType<typeof resolveLiveRoles> = resolveLiveRoles()
): boolean {
  return !isRelayOnly(roles);
}

function resolveLiveDeps(deps: LiveGatewayStartDeps): ResolvedLiveDeps {
  return {
    startLag: startGatewayEventLoopLag,
    ensureLocale: () => ensureI18nLocale(getSiteSettings().language),
    refreshTelegram: refreshTelegramService,
    refreshWeixin: refreshWeixinService,
    startPush: () => pushSupervisor.start(),
    startAgent: startAgentSupervisor,
    startWatch: startWatchService,
    startTunnel: startTunnelManager,
    loadTunnel: async () => {
      await loadTunnelManager();
    },
    startExportSweeper: startPortMapExportSweeper,
    startPortMaps: startPortMapManager,
    sendOnline: sendGatewayOnlineMessages,
    ...deps,
    gates: { ...defaultLiveStartGates, ...deps.gates },
  };
}

/** 未配置的子系统不在开机时 import / start；首个相关 REST 请求或用户启用时再懒加载。 */
async function startConfiguredServices(d: ResolvedLiveDeps): Promise<void> {
  await d.ensureLocale();
  if (d.gates.telegram()) await d.refreshTelegram();
  if (d.gates.weixin()) await d.refreshWeixin();
  await d.startPush();
  if (d.gates.agent()) await d.startAgent();
  if (d.gates.watch()) await d.startWatch();
  if (d.gates.tunnel()) await d.startTunnel();
  d.startExportSweeper();
  if (d.gates.portMaps()) await d.startPortMaps();
  await d.sendOnline();
}

export async function startLiveGatewayServices(deps: LiveGatewayStartDeps = {}): Promise<void> {
  const messaging = shouldStartMessagingServices(deps.roles ?? resolveLiveRoles());
  const resolved = resolveLiveDeps(deps);
  resolved.startLag();
  armMessagingHooks();
  setLiveServicesEnabled(messaging);
  if (messaging) return startConfiguredServices(resolved);
  await resolved.ensureLocale();
  if (resolved.gates.tunnel()) await resolved.loadTunnel();
}

async function stopGatewayLiveServices(): Promise<void> {
  stopGatewayEventLoopLag();
  markLiveServicesStopping();
  resetMessagingHooksIfLoaded();
  connectionAlertNotifier.setBroadcaster(null);
  connectionAlertNotifier.setEventEmitter(null);
  registerSettingsBroadcaster(null);
  registerEventNotifyBroadcaster(null);
  registerTreeOverlayBridge(null);
  await stopPortMapsIfLoaded();
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

      if (isExecWsPath(url.pathname)) {
        return handleExecWsUpgrade(req, bunServer, authenticateOpenExecUpgrade);
      }

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
        if (isExecWsSocket(ws)) return execWebSocketHandlers.open(ws);
        wsServer.handleOpen(ws as Bun.ServerWebSocket<GatewaySocketData>, opts);
      },
      message(ws, message) {
        if (isExecWsSocket(ws)) return execWebSocketHandlers.message(ws, message);
        wsServer.handleMessage(ws as Bun.ServerWebSocket<GatewaySocketData>, message);
      },
      drain(ws) {
        if (isExecWsSocket(ws)) return execWebSocketHandlers.drain(ws);
        const data = (ws as Bun.ServerWebSocket<GatewaySocketData>).data;
        if (!data?.session || data.session.closed) return;
        wsServer.handleDrain(data.session, data.carrier);
      },
      close(ws, code, reason) {
        if (isExecWsSocket(ws)) return execWebSocketHandlers.close(ws);
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
