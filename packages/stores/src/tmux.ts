// tmux store 组装根：状态字段 + 命令下发，事件路由/pane 订阅/选择面拆到同目录模块。

import { getTmuxWindowStyle } from '@tmex/shared';
import type { ConnectionState } from '@tmex/ws-client';
import { create } from 'zustand';
import { createPaneSubscriptionManager } from './pane-subscriptions';
import type { RuntimeCore } from './runtime';
import type { SiteStore } from './site';
import { createTmuxDeviceActions } from './tmux-device-actions';
import { createTmuxEventRouter } from './tmux-event-router';
import { createTmuxSelectionActions } from './tmux-selection-actions';
import type { DeviceError, TmuxState } from './tmux-state';
import { createTmuxViewportActions } from './tmux-viewport-actions';
import type { UIStore } from './ui';

export type { DeviceInitialErrorInput, TmuxState } from './tmux-state';

const CONNECT_DEDUP_WINDOW_MS = 500;

export interface TmuxStoreDeps {
  getUI: () => UIStore;
  getSite: () => SiteStore;
}

export function createTmuxStore(
  core: RuntimeCore,
  deps: TmuxStoreDeps,
  disposers: Array<() => void> = []
) {
  const lastConnectSentAt = new Map<string, number>();
  const paneSubscriptions = createPaneSubscriptionManager(core);

  function shouldSkipDuplicateConnect(deviceId: string): boolean {
    const now = Date.now();
    const last = lastConnectSentAt.get(deviceId);
    if (last !== undefined && now - last < CONNECT_DEDUP_WINDOW_MS) {
      return true;
    }
    lastConnectSentAt.set(deviceId, now);
    return false;
  }

  // gateway 连接设备时按 TMEX_TMUX_WINDOW_STYLE 注入默认（暗色）window-style，
  // 这里在设备连上/重连/主题切换时按前端当前主题覆盖，保持 tmux 代答的 OSC 10/11 颜色一致。
  function sendWindowStyleForCurrentTheme(deviceId: string): void {
    const style = getTmuxWindowStyle(deps.getUI().getState().theme);
    core.transport.send({ type: 'set-window-style', deviceId, style });
  }

  return create<TmuxState>((set, get) => {
    const selection = createTmuxSelectionActions(core, { getState: get, setState: set });
    const device = createTmuxDeviceActions(core, {
      getState: get,
      setState: set,
      shouldSkipDuplicateConnect,
      lastConnectSentAt,
      cancelReselect: selection.cancelReselect,
      paneSubscriptions,
    });
    disposers.push(() => {
      selection.dispose();
    });

    let initialized = false;

    const handleReady = (): void => {
      lastConnectSentAt.clear();
      set((prev) => {
        const cleared = { ...prev.deviceReconnecting };
        for (const key of Object.keys(cleared)) cleared[key] = undefined;
        return { deviceReconnecting: cleared };
      });
      for (const deviceId of get().connectedDevices) {
        if (!shouldSkipDuplicateConnect(deviceId)) {
          core.transport.send({ type: 'connect-device', deviceId });
        }
        if (paneSubscriptions.currentPaneSubscriptions(deviceId).length > 0) {
          paneSubscriptions.sendPaneSubscriptions(deviceId);
        }
      }
    };

    const setupTransportHandlers = (): void => {
      if (initialized) return;
      initialized = true;

      // 选择状态机的输出/历史统一经 pane-sink-registry 按 (deviceId, paneId) 路由到
      // 各 Terminal 实例（分屏多实例）；回调一次性设置，Terminal 只注册/注销 sink
      core.selectMachine({
        onResetTerminal: (deviceId, paneId) => {
          core.paneSinks.dispatchPaneReset(deviceId, paneId);
        },
        onApplyHistory: (deviceId, paneId, data, alternateScreen, modes) => {
          core.paneSinks.dispatchPaneApplyHistory(deviceId, paneId, data, alternateScreen, modes);
        },
        onFlushBuffer: (deviceId, paneId, buffer) => {
          for (const chunk of buffer) {
            core.paneSinks.dispatchPaneOutput(deviceId, paneId, chunk);
          }
        },
        onOutput: (deviceId, paneId, data) => {
          core.paneSinks.dispatchPaneOutput(deviceId, paneId, data);
        },
        onSelectFailed: selection.handleSelectFailed,
        onRebaseRequired: (deviceId, paneId, reason) => {
          core.paneSinks.dispatchPaneRebase(deviceId, paneId, reason);
        },
      });

      const routeEvent = createTmuxEventRouter(
        {
          core,
          getState: get,
          setState: set,
          getSite: deps.getSite,
          selection,
          paneSubscriptions,
          onReady: handleReady,
          sendWindowStyleForCurrentTheme,
        },
        disposers
      );

      disposers.push(core.transport.onEvent(routeEvent));
      const initialState = core.transport.getState();
      set({
        connectionState: initialState,
        hasConnectedOnce: core.transport.hasConnectedOnce,
        wsLatencyMs: core.transport.latencyMs,
        wsLatencyRawMs: core.transport.latencyRawMs ?? null,
      });
      if (initialState === 'READY') handleReady();

      // 主题切换时同步所有已连接设备的 tmux window-style
      let lastTheme = deps.getUI().getState().theme;
      disposers.push(
        deps.getUI().subscribe((uiState) => {
          if (uiState.theme === lastTheme) return;
          lastTheme = uiState.theme;
          const state = get();
          for (const deviceId of state.connectedDevices) {
            if (state.deviceConnected[deviceId]) {
              sendWindowStyleForCurrentTheme(deviceId);
            }
          }
        })
      );
    };

    return {
      ...createTmuxViewportActions(core, { recordTerminalSize: selection.recordTerminalSize }),

      connectionState: 'IDLE' as ConnectionState,
      hasConnectedOnce: false,
      wsLatencyMs: null,
      wsLatencyRawMs: null,
      snapshots: {},
      connectedDevices: new Set(),
      deviceConnected: {},
      deviceErrors: {},
      deviceReconnecting: {},
      selectedPanes: {},
      activePaneFromEvent: {},
      pendingCreateWindowAt: {},
      viewportPolicy: {},

      ensureSocketConnected() {
        setupTransportHandlers();
        core.transport.connect();
      },

      connectDevice: device.connectDevice,

      disconnectDevice: device.disconnectDevice,

      clearDeviceError(deviceId) {
        set((prev) => ({
          deviceErrors: { ...prev.deviceErrors, [deviceId]: undefined },
          deviceReconnecting: { ...prev.deviceReconnecting, [deviceId]: undefined },
        }));
      },

      hydrateDeviceErrors(entries) {
        set((prev) => {
          const next: Record<string, DeviceError | undefined> = { ...prev.deviceErrors };
          for (const entry of entries) {
            if (next[entry.deviceId]) continue;
            if (!entry.lastError || !entry.lastErrorType) continue;
            next[entry.deviceId] = {
              message: entry.lastError,
              type: entry.lastErrorType,
              at: 0,
            };
          }
          return { deviceErrors: next };
        });
      },

      selectPane: selection.selectPane,

      selectWindow: selection.selectWindow,

      focusPane: selection.focusPane,

      sendInput(deviceId, paneId, data, isComposing = false) {
        if (!deviceId || !paneId) return;
        core.transport.send({ type: 'terminal-input', deviceId, paneId, data, isComposing });
      },

      paste(deviceId, paneId, data) {
        if (!deviceId || !paneId) return;
        core.transport.send({ type: 'terminal-paste', deviceId, paneId, data });
      },

      createWindow(deviceId, name, cwd) {
        if (!deviceId) return;
        core.transport.send({ type: 'create-window', deviceId, name, cwd });
        set((prev) => ({
          pendingCreateWindowAt: { ...prev.pendingCreateWindowAt, [deviceId]: Date.now() },
        }));
      },

      clearPendingCreateWindow(deviceId) {
        if (!deviceId) return;
        set((prev) => {
          if (prev.pendingCreateWindowAt[deviceId] === undefined) return prev;
          const next = { ...prev.pendingCreateWindowAt };
          delete next[deviceId];
          return { pendingCreateWindowAt: next };
        });
      },

      closeWindow(deviceId, windowId) {
        if (!deviceId || !windowId) return;
        core.transport.send({ type: 'close-window', deviceId, windowId });
      },

      closePane(deviceId, paneId) {
        if (!deviceId || !paneId) return;
        core.transport.send({ type: 'close-pane', deviceId, paneId });
      },

      renameWindow(deviceId, windowId, name) {
        if (!deviceId || !windowId) return;
        core.transport.send({ type: 'rename-window', deviceId, windowId, name });
      },

      reorderWindows: device.reorderWindows,

      subscribePanes(deviceId, paneIds) {
        if (!deviceId) return;
        paneSubscriptions.setManualSubscriptions(deviceId, paneIds);
      },

      mountPane(deviceId, paneId) {
        if (!deviceId || !paneId) return () => {};
        return paneSubscriptions.mountPane(deviceId, paneId);
      },

      requestPaneScreen(deviceId, paneId) {
        if (!deviceId || !paneId) return;
        paneSubscriptions.requestPaneScreen(deviceId, paneId);
      },

      fetchPaneHistory(deviceId, paneId, cursor = null) {
        if (!deviceId || !paneId) return;
        paneSubscriptions.fetchPaneHistory(deviceId, paneId, cursor);
      },

      splitPane(deviceId, paneId, direction, cwd) {
        if (!deviceId || !paneId) return;
        core.transport.send({ type: 'split-pane', deviceId, paneId, direction, cwd });
      },

      renamePane(deviceId, paneId, name) {
        if (!deviceId || !paneId) return;
        core.transport.send({ type: 'rename-pane', deviceId, paneId, name });
      },

      movePane(deviceId, srcPaneId, dstPaneId, position) {
        if (!deviceId || !srcPaneId || !dstPaneId || srcPaneId === dstPaneId) return;
        core.transport.send({ type: 'move-pane', deviceId, srcPaneId, dstPaneId, position });
      },

      breakPane(deviceId, paneId) {
        if (!deviceId || !paneId) return;
        core.transport.send({ type: 'break-pane', deviceId, paneId });
      },

      reorderPanes: device.reorderPanes,

      syncThemeAfterResize(deviceId) {
        if (!deviceId) return;
        if (!core.transport.isReady()) return;
        sendWindowStyleForCurrentTheme(deviceId);
      },
    };
  });
}

export type TmuxStore = ReturnType<typeof createTmuxStore>;
