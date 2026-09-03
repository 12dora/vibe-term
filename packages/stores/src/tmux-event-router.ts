// gateway transport 事件路由：按事件类型分发到独立 handler，替代单个大 switch。

import {
  type DeferredClipboardWriter,
  type EventDevicePayload,
  createDeferredClipboardWriter,
} from '@tmex/shared';
import type { ConnectionState, GatewayTransportEvent } from '@tmex/ws-client';
import type { PaneSubscriptionManager } from './pane-subscriptions';
import {
  type TmuxDomainEventContext,
  handleDeviceEvent,
  handleTmuxEvent,
} from './tmux-device-events';
import type { TmuxSelectionActions } from './tmux-selection-actions';
import { applyViewportPolicy, clearViewportPolicyForDevice } from './viewport-policy';

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

// 传输层是否曾经 READY 过：只有「READY 之后又离开 READY」才是真的断流，
// 首次连接过程中的 WS_CONNECTING / HELLO_NEGOTIATING 不算。
const transportWasReady = new WeakMap<TmuxEventRouterContext, boolean>();

/**
 * 网关 WS 自身重连同样让每个设备的字节流出现缺口：backoff 期间的 pane 输出没人收，
 * 而 READY 之后只有当前 pane 会被重选，隐藏的保活实例会带着断裂的缓冲继续算 warm。
 */
function handleTransportStateChange(ctx: TmuxEventRouterContext, state: ConnectionState): void {
  const wasReady = transportWasReady.get(ctx) === true;
  transportWasReady.set(ctx, state === 'READY');
  if (!wasReady || state === 'READY') return;

  for (const deviceId of ctx.getState().connectedDevices) {
    ctx.core.paneSinks.cleanupDevicePaneState(deviceId);
    // 网关侧的视口声明随会话一起消失：本地策略同样作废，重连前按默认 owner 上报
    ctx.setState((prev) => ({
      viewportPolicy: clearViewportPolicyForDevice(prev.viewportPolicy, deviceId),
    }));
  }
}

const handlers: TmuxEventHandlers = {
  'connection-state': (event, ctx) => {
    handleTransportStateChange(ctx, event.state);
    ctx.setState((prev) => ({
      connectionState: event.state,
      hasConnectedOnce: event.state === 'READY' ? true : prev.hasConnectedOnce,
      wsLatencyMs: event.state === 'READY' ? prev.wsLatencyMs : null,
      wsLatencyRawMs: event.state === 'READY' ? prev.wsLatencyRawMs : null,
    }));
    if (event.state === 'READY') ctx.onReady();
  },

  'state-feed-mode': (event, ctx) => {
    ctx.setState({ stateFeedMode: event.mode });
  },

  latency: (event, ctx) => {
    const prev = ctx.getState();
    const wsLatencyMs = Math.round(event.latencyMs);
    const wsLatencyRawMs = Math.round(event.rawMs);
    if (prev.wsLatencyMs === wsLatencyMs && prev.wsLatencyRawMs === wsLatencyRawMs) return;
    ctx.setState({ wsLatencyMs, wsLatencyRawMs });
  },

  // 网关低于 canonical v1.1 门槛：状态流建不起来且不回退，store 里 stateFeedMode 记
  // 'unsupported' 供 UI 判断，另外弹一次提示——否则终端只会一直空白，用户无从判断原因。
  'server-too-old': (event, ctx) => {
    console.error(
      '[tmux] gateway too old for canonical state v1.1:',
      `server=${event.serverVersion ?? 'unknown'} required>=${event.minVersion}`
    );
    ctx.core.notifications.error(
      ctx.core.t('websocket.serverTooOld', { minVersion: event.minVersion })
    );
  },

  'device-connected': (event, ctx) => {
    ctx.setState((prev) => ({
      deviceConnected: { ...prev.deviceConnected, [event.deviceId]: true },
      deviceErrors: { ...prev.deviceErrors, [event.deviceId]: undefined },
      deviceReconnecting: { ...prev.deviceReconnecting, [event.deviceId]: undefined },
    }));
    ctx.sendWindowStyleForCurrentTheme(event.deviceId);
  },

  'device-disconnected': (event, ctx) => {
    ctx.core.paneSinks.cleanupDevicePaneState(event.deviceId);
    ctx.setState((prev) => ({
      deviceConnected: { ...prev.deviceConnected, [event.deviceId]: false },
      viewportPolicy: clearViewportPolicyForDevice(prev.viewportPolicy, event.deviceId),
    }));
  },

  'device-event': (event, ctx) => {
    // 自动重连只置 deviceReconnecting（deviceConnected 仍为 true），但流确实断了：
    // 与断开同等对待，缓冲里的字节已经不连续，必须丢掉等各 pane 重新拉快照
    if (isDeviceStreamInterruption(event.event)) {
      ctx.core.paneSinks.cleanupDevicePaneState(event.event.deviceId);
    }
    handleDeviceEvent(ctx, event.event);
    if (event.event.type === 'reconnected') {
      ctx.sendWindowStyleForCurrentTheme(event.event.deviceId);
    }
  },

  'terminal-viewport-policy': (event, ctx) => {
    ctx.setState((prev) => {
      const viewportPolicy = applyViewportPolicy(prev.viewportPolicy, event);
      return viewportPolicy === prev.viewportPolicy ? {} : { viewportPolicy };
    });
  },

  'metadata-snapshot': (event, ctx) => {
    const { deviceId } = event.snapshot;
    const previous = ctx.getState().snapshots[deviceId];
    ctx.setState((prev) => ({
      snapshots: { ...prev.snapshots, [deviceId]: event.snapshot },
    }));
    ctx.selection.handleSnapshotPaneRemoval(deviceId, previous);
  },

  // patch 已在 ws-client 合并并按设备树顺序排好，这里只替换整棵快照
  'metadata-patch': (event, ctx) => {
    const previous = ctx.getState().snapshots[event.deviceId];
    if (!previous) return;
    ctx.setState((prev) => ({
      snapshots: { ...prev.snapshots, [event.deviceId]: event.snapshot },
    }));
    ctx.selection.handleSnapshotPaneRemoval(event.deviceId, previous);
  },

  'tmux-event': (event, ctx) => {
    handleTmuxEvent(ctx, event.event);
  },

  'terminal-data': (event, ctx) => {
    ctx.core.paneSinks.dispatchPaneTerminalData(event.frame);
  },

  'screen-snapshot': (event, ctx) => {
    ctx.core.paneSinks.dispatchPaneScreenSnapshot(event.snapshot);
  },

  'history-page': (event, ctx) => {
    ctx.core.paneSinks.dispatchPaneHistoryPage(event.page);
  },

  'subscription-applied': (event, ctx) => {
    const rejections =
      event.rejections ??
      event.rejectedPaneIds.map((paneId) => ({
        deviceId: event.deviceId,
        paneId,
        reason: 'resource_exhausted' as const,
      }));
    for (const rejection of rejections) {
      if (rejection.reason === 'not_found') continue;
      ctx.core.paneSinks.dispatchPaneRebase(rejection.deviceId, rejection.paneId, rejection.reason);
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
