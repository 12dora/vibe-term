// gateway transport 事件路由：按事件类型分发到独立 handler，替代单个大 switch。

import { wsBorsh } from '@tmex/shared';
import type { GatewayTransportEvent } from '@tmex/ws-client';
import type { PaneSubscriptionManager } from './pane-subscriptions';
import {
  type TmuxDomainEventContext,
  handleDeviceEvent,
  handleTmuxEvent,
} from './tmux-device-events';
import type { TmuxSelectionActions } from './tmux-selection-actions';

export interface TmuxEventRouterContext extends TmuxDomainEventContext {
  selection: TmuxSelectionActions;
  paneSubscriptions: PaneSubscriptionManager;
  /** 连接进入 READY：重连设备并重放 pane 订阅 */
  onReady(): void;
  sendWindowStyleForCurrentTheme(deviceId: string): void;
}

type EventOfType<T extends GatewayTransportEvent['type']> = Extract<
  GatewayTransportEvent,
  { type: T }
>;

type TmuxEventHandlers = {
  [T in GatewayTransportEvent['type']]: (
    event: EventOfType<T>,
    ctx: TmuxEventRouterContext
  ) => void;
};

const handlers: TmuxEventHandlers = {
  'connection-state': (event, ctx) => {
    ctx.setState((prev) => ({
      connectionState: event.state,
      hasConnectedOnce: event.state === 'READY' ? true : prev.hasConnectedOnce,
      wsLatencyMs: event.state === 'READY' ? prev.wsLatencyMs : null,
    }));
    if (event.state === 'READY') ctx.onReady();
  },

  latency: (event, ctx) => {
    ctx.setState({ wsLatencyMs: event.latencyMs });
  },

  'terminal-progress': (event, ctx) => {
    ctx.core.selectMachine().reportTerminalProgress(event.deviceId);
  },

  'device-connected': (event, ctx) => {
    ctx.setState((prev) => ({
      deviceConnected: { ...prev.deviceConnected, [event.deviceId]: true },
      deviceErrors: { ...prev.deviceErrors, [event.deviceId]: undefined },
      deviceReconnecting: { ...prev.deviceReconnecting, [event.deviceId]: undefined },
    }));
    ctx.sendWindowStyleForCurrentTheme(event.deviceId);
    if (!ctx.core.transport.capabilities.atomicScreen) {
      ctx.selection.maybeReselectCurrentPane(event.deviceId);
    }
  },

  'device-disconnected': (event, ctx) => {
    ctx.core.selectMachine().cleanup(event.deviceId);
    ctx.core.paneSinks.cleanupDevicePaneState(event.deviceId);
    ctx.setState((prev) => ({
      deviceConnected: { ...prev.deviceConnected, [event.deviceId]: false },
    }));
  },

  'device-event': (event, ctx) => {
    handleDeviceEvent(ctx, event.event);
    if (event.event.type === 'reconnected') {
      ctx.sendWindowStyleForCurrentTheme(event.event.deviceId);
      if (!ctx.core.transport.capabilities.atomicScreen) {
        ctx.selection.maybeReselectCurrentPane(event.event.deviceId);
      }
    }
  },

  'metadata-snapshot': (event, ctx) => {
    ctx.setState((prev) => ({
      snapshots: { ...prev.snapshots, [event.snapshot.deviceId]: event.snapshot },
    }));
  },

  'metadata-patch': (event, ctx) => {
    ctx.setState((prev) => {
      const current = prev.snapshots[event.deviceId];
      if (!current) return {};
      return {
        snapshots: {
          ...prev.snapshots,
          [event.deviceId]: wsBorsh.applyLegacyStateSnapshotDiff(current, event.patch),
        },
      };
    });
  },

  'tmux-event': (event, ctx) => {
    handleTmuxEvent(ctx, event.event);
  },

  'selection-ack': (event, ctx) => {
    ctx.core.selectMachine().dispatch({
      type: 'SWITCH_ACK',
      deviceId: event.deviceId,
      selectToken: event.selectToken,
    });
  },

  'legacy-history': (event, ctx) => {
    const routed = ctx.core.paneSinks.dispatchPaneHistory(
      event.deviceId,
      event.paneId,
      event.selectToken,
      event.data,
      event.alternateScreen,
      event.modes
    );
    if (routed) return;
    ctx.core.selectMachine().dispatch({
      type: 'HISTORY',
      deviceId: event.deviceId,
      selectToken: event.selectToken,
      data: event.data,
      alternateScreen: event.alternateScreen,
      modes: event.modes,
    });
  },

  'live-resume': (event, ctx) => {
    ctx.core.selectMachine().dispatch({
      type: 'LIVE_RESUME',
      deviceId: event.deviceId,
      selectToken: event.selectToken,
    });
  },

  'terminal-data': (event, ctx) => {
    if (event.frame.seqStart === undefined) {
      ctx.core.selectMachine().dispatch({
        type: 'OUTPUT',
        deviceId: event.frame.deviceId,
        paneId: event.frame.paneId,
        data: event.frame.data,
      });
      return;
    }
    ctx.core.paneSinks.dispatchPaneTerminalData(event.frame);
  },

  'screen-snapshot': (event, ctx) => {
    ctx.core.paneSinks.dispatchPaneScreenSnapshot(event.snapshot);
  },

  'history-page': (event, ctx) => {
    ctx.core.paneSinks.dispatchPaneHistoryPage(event.page);
  },

  'subscription-applied': (event, ctx) => {
    for (const paneId of event.rejectedPaneIds) {
      ctx.core.paneSinks.dispatchPaneRebase(event.deviceId, paneId, 'resource_exhausted');
    }
  },

  'rebase-required': (event, ctx) => {
    if (event.reason === 'metadata_gap') return;
    const { deviceId, paneId, reason } = event;
    if (deviceId && paneId) {
      ctx.core.paneSinks.dispatchPaneRebase(deviceId, paneId, reason);
      return;
    }
    ctx.paneSubscriptions.forEachMountedPane((mountedDeviceId, mountedPaneId) => {
      if (deviceId && deviceId !== mountedDeviceId) return;
      ctx.core.paneSinks.dispatchPaneRebase(mountedDeviceId, mountedPaneId, reason);
    });
  },

  'clipboard-write': (event, ctx) => {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') {
      return;
    }
    const current = ctx.getState().selectedPanes[event.deviceId];
    if (!current || current.paneId !== event.paneId) {
      return;
    }
    void ctx.core.host.writeClipboardText(event.text).then(
      () => {
        ctx.core.notifications.success(ctx.core.t('terminal.copied'));
      },
      (err) => {
        console.warn('[tmux] clipboard write failed:', err);
        ctx.core.notifications.error(ctx.core.t('terminal.copyFailed'));
      }
    );
  },

  'site-theme-update': (event, ctx) => {
    ctx.getSite().getState().setThemeFromS2C(event.theme);
  },

  'settings-update': (event, ctx) => {
    ctx.getSite().getState().handleSettingsUpdate(event.namespace);
  },

  'transport-error': (event) => {
    console.error('[tmux] gateway transport error:', event.error);
  },
};

export function createTmuxEventRouter(
  ctx: TmuxEventRouterContext
): (event: GatewayTransportEvent) => void {
  return (event) => {
    const handler = handlers[event.type] as
      | ((event: GatewayTransportEvent, ctx: TmuxEventRouterContext) => void)
      | undefined;
    handler?.(event, ctx);
  };
}
