import { agentSupervisor } from './agent/supervisor';
import { type SystemApiHandler, handleApiRequest } from './api';
import { json } from './api/http';
import type { AuthDb } from './auth/types';
import { config } from './config';
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
import { type DispatchContext, requestDispatchContext } from './mesh/types';
import { connectionAlertNotifier } from './push/connection-alerts';
import { pushSupervisor } from './push/supervisor';
import { registerSettingsBroadcaster, registerTreeOverlayBridge } from './settings/broadcaster';
import { telegramService } from './telegram/service';
import { tmuxRuntimeRegistry } from './tmux-client/registry';
import { primeLocalShellPath } from './tmux/local-shell-path';
import { registerSnapshotLookup } from './tmux/snapshot-directory';
import { registerThemeBroadcaster } from './tmux/theme-broadcaster';
import { tunnelManager } from './tunnel/manager';
import { watchService } from './watch/service';
import { weixinService } from './weixin/service';
import { WebSocketServer } from './ws';
import type { GatewaySocketData } from './ws/types';
import { GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES } from './ws/websocket-send-guard';

interface GatewayRuntimeOptions {
  runMigrationsOnStart?: boolean;
  initializeSiteSettings?: boolean;
  migrationsFolder?: string;
  systemApiHandler?: SystemApiHandler;
}

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
    open: (ws: Bun.ServerWebSocket<unknown>) => void;
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

export async function createGatewayRuntime(
  options: GatewayRuntimeOptions = {}
): Promise<GatewayRuntime> {
  const {
    runMigrationsOnStart = true,
    initializeSiteSettings = true,
    migrationsFolder,
    systemApiHandler,
  } = options;

  if (runMigrationsOnStart) {
    runMigrations(migrationsFolder);
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

  const wsServer = new WebSocketServer();
  const db = getOrmDb();
  wsServer.currentTheme = getSiteSettings().theme;
  connectionAlertNotifier.setBroadcaster((deviceId, payload) => {
    wsServer.broadcastDeviceError(deviceId, payload);
  });
  connectionAlertNotifier.setEventEmitter((eventType, event) => {
    void eventNotifier.notify(eventType, event);
  });
  registerSnapshotLookup((deviceId) => wsServer.getLastSnapshot(deviceId));
  registerThemeBroadcaster(
    (theme) => {
      wsServer.scheduleTmuxThemeApply(theme);
    },
    (theme) => {
      wsServer.broadcastSiteThemeUpdateS2C(theme);
    }
  );
  registerSettingsBroadcaster((namespace) => {
    wsServer.broadcastSettingsUpdate(namespace);
  });
  registerEventNotifyBroadcaster((eventType, event) => {
    wsServer.broadcastEventNotify(eventType, event);
  });
  registerTreeOverlayBridge({
    reorderWindows: (deviceId, windowIds) => wsServer.reorderWindows(deviceId, windowIds),
    reorderPanes: (deviceId, windowId, paneIds) =>
      wsServer.reorderPanes(deviceId, windowId, paneIds),
    renameWindow: (deviceId, windowId, name) => wsServer.renameWindow(deviceId, windowId, name),
    renamePane: (deviceId, paneId, name) => wsServer.renamePane(deviceId, paneId, name),
    getCustomNames: (deviceId) => wsServer.getCustomNames(deviceId),
  });
  await telegramService.refresh();
  await weixinService.refresh();
  await pushSupervisor.start();
  await agentSupervisor.start();
  await watchService.start();
  await tunnelManager.start();

  try {
    const settings = getSiteSettings();
    await telegramService.sendGatewayOnlineMessage(settings.siteName);
    await weixinService.sendGatewayOnlineMessage(settings.siteName);
  } catch (err) {
    console.error('[gateway] failed to push startup message:', err);
  }

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
      backpressureLimit: GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES,
      closeOnBackpressureLimit: true,
      open(ws) {
        wsServer.handleOpen(ws as Bun.ServerWebSocket<GatewaySocketData>);
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
      agentSupervisor.restoreRemoteSessions();
    },
    stopAgentSessions() {
      return agentSupervisor.stop();
    },
    async stop() {
      connectionAlertNotifier.setBroadcaster(null);
      connectionAlertNotifier.setEventEmitter(null);
      registerThemeBroadcaster(null);
      registerSettingsBroadcaster(null);
      registerEventNotifyBroadcaster(null);
      registerTreeOverlayBridge(null);
      wsServer.closeAll();
      await tunnelManager.stop();
      await watchService.stop();
      await agentSupervisor.stop();
      await pushSupervisor.stopAll();
      await tmuxRuntimeRegistry.shutdownAll();
      await telegramService.stopAll();
      await weixinService.stopAll();
    },
  };
}
