// gateway transport 事件路由：按事件类型分发到独立 handler，替代单个大 switch。

import {
  type DeferredClipboardWriter,
  type EventDevicePayload,
  createDeferredClipboardWriter,
  wsBorsh,
} from '@tmex/shared';
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

// 远端（OSC52）发起的复制没有用户激活，iOS Safari 会拒绝写剪贴板：交给延迟写入器挂起，
// 等下一次真实手势重试。writer 按 router 上下文缓存，挂起状态才能跨事件存活。
const clipboardWriters = new WeakMap<TmuxEventRouterContext, DeferredClipboardWriter>();

function clipboardWriterFor(ctx: TmuxEventRouterContext): DeferredClipboardWriter {
  const existing = clipboardWriters.get(ctx);
  if (existing) return existing;

  const writer = createDeferredClipboardWriter(
    {
      onPending: () => ctx.core.notifications.info(ctx.core.t('terminal.copyPending')),
      onSuccess: () => ctx.core.notifications.success(ctx.core.t('terminal.copied')),
      onFailure: (error) => {
        console.warn('[tmux] clipboard write failed:', error);
        ctx.core.notifications.error(ctx.core.t('terminal.copyFailed'));
      },
    },
    { write: (text) => ctx.core.host.writeClipboardText(text) }
  );
  clipboardWriters.set(ctx, writer);
  return writer;
}

function disposeClipboardWriter(ctx: TmuxEventRouterContext): void {
  const writer = clipboardWriters.get(ctx);
  if (!writer) return;
  clipboardWriters.delete(ctx);
  writer.dispose();
}

// 自动重连（error/reconnecting）与断开一样都会让 pane 的字节流出现缺口
function isDeviceStreamInterruption(event: EventDevicePayload): boolean {
  if (event.type === 'disconnected') return true;
  return event.type === 'error' && event.errorType === 'reconnecting';
}

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
    ctx.selection.handleDeviceStreamInterrupted(event.deviceId);
    ctx.core.paneSinks.cleanupDevicePaneState(event.deviceId);
    ctx.setState((prev) => ({
      deviceConnected: { ...prev.deviceConnected, [event.deviceId]: false },
    }));
  },

  'device-event': (event, ctx) => {
    // 自动重连只置 deviceReconnecting（deviceConnected 仍为 true），但流确实断了：
    // 与断开同等对待，否则重连后旧事务还挂着，maybeReselectCurrentPane 会直接早退
    if (isDeviceStreamInterruption(event.event)) {
      ctx.selection.handleDeviceStreamInterrupted(event.event.deviceId);
    }
    handleDeviceEvent(ctx, event.event);
    if (event.event.type === 'reconnected') {
      ctx.sendWindowStyleForCurrentTheme(event.event.deviceId);
      if (!ctx.core.transport.capabilities.atomicScreen) {
        ctx.selection.maybeReselectCurrentPane(event.event.deviceId);
      }
    }
  },

  'metadata-snapshot': (event, ctx) => {
    const { deviceId } = event.snapshot;
    const previous = ctx.getState().snapshots[deviceId];
    ctx.setState((prev) => ({
      snapshots: { ...prev.snapshots, [deviceId]: event.snapshot },
    }));
    ctx.selection.handleSnapshotPaneRemoval(deviceId, previous);
  },

  'metadata-patch': (event, ctx) => {
    const previous = ctx.getState().snapshots[event.deviceId];
    if (!previous) return;
    ctx.setState((prev) => ({
      snapshots: {
        ...prev.snapshots,
        [event.deviceId]: wsBorsh.applyLegacyStateSnapshotDiff(previous, event.patch),
      },
    }));
    ctx.selection.handleSnapshotPaneRemoval(event.deviceId, previous);
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
    ctx.selection.observeSelectHistory(event.deviceId, event.selectToken);
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
    ctx.selection.observeSelectLiveResume(event.deviceId, event.selectToken);
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
    void clipboardWriterFor(ctx).write(event.text);
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

  'pending-overflow': (event, ctx) => {
    console.warn('[tmux] pending send overflow:', event);
    ctx.core.notifications.error(ctx.core.t('websocket.inputDropped'));
  },
};

export function createTmuxEventRouter(
  ctx: TmuxEventRouterContext,
  disposers?: Array<() => void>
): (event: GatewayTransportEvent) => void {
  // 挂起中的延迟写入器持有全局手势监听：runtime 拆卸时必须一并释放，
  // 否则卸载后的手势仍会写剪贴板并弹通知
  disposers?.push(() => disposeClipboardWriter(ctx));
  return (event) => {
    const handler = handlers[event.type] as
      | ((event: GatewayTransportEvent, ctx: TmuxEventRouterContext) => void)
      | undefined;
    handler?.(event, ctx);
  };
}
