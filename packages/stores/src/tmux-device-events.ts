// 设备事件与 tmux 事件（bell / notification / pane-active）的状态与副作用处理。

import { formatTerminalNotificationToast, useBellStore } from '@tmex/notifications';
import type {
  DeviceEventType,
  EventDevicePayload,
  EventTmuxPayload,
  TmuxEventType,
} from '@tmex/shared';
import { toAppPath } from './app-navigation';
import { type RuntimeCore, hostAppPath } from './runtime';
import type { SiteStore } from './site';
import type { TmuxGetState, TmuxSetState } from './tmux-state';

export interface TmuxDomainEventContext {
  core: RuntimeCore;
  getState: TmuxGetState;
  setState: TmuxSetState;
  getSite: () => SiteStore;
}

type DeviceEventHandler = (ctx: TmuxDomainEventContext, payload: EventDevicePayload) => void;
type TmuxEventHandler = (ctx: TmuxDomainEventContext, payload: EventTmuxPayload) => void;

function eventData(payload: EventTmuxPayload): Record<string, unknown> {
  const data = payload.data;
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' ? value : undefined;
}

function markDeviceReconnecting(
  ctx: TmuxDomainEventContext,
  deviceId: string,
  message: string
): void {
  ctx.setState((prev) => ({
    deviceReconnecting: {
      ...prev.deviceReconnecting,
      [deviceId]: { message, at: Date.now() },
    },
  }));
}

function recordDeviceError(
  ctx: TmuxDomainEventContext,
  payload: EventDevicePayload,
  error: { message: string; type: string }
): void {
  ctx.setState((prev) => ({
    deviceErrors: {
      ...prev.deviceErrors,
      [payload.deviceId]: {
        message: error.message,
        type: error.type,
        rawMessage: payload.rawMessage,
        at: Date.now(),
      },
    },
    deviceReconnecting: { ...prev.deviceReconnecting, [payload.deviceId]: undefined },
  }));
}

const handleDeviceError: DeviceEventHandler = (ctx, payload) => {
  const summary = payload.message ?? 'Device Error';
  const errorType = payload.errorType ?? 'unknown';

  if (errorType === 'reconnecting') {
    markDeviceReconnecting(ctx, payload.deviceId, summary);
    return;
  }

  const previousError = ctx.getState().deviceErrors[payload.deviceId];
  const shouldToast = !previousError || previousError.type !== errorType;
  recordDeviceError(ctx, payload, { message: summary, type: errorType });

  // 宿主接管通知呈现时设备错误 toast 一并让位；deviceErrors 状态照写（错误横幅等 UI 状态不受影响）
  if (shouldToast && !ctx.core.features.hostManagedNotifications) {
    ctx.core.notifications.error(summary);
  }
};

const handleDeviceDisconnected: DeviceEventHandler = (ctx, payload) => {
  ctx.core.selectMachine().cleanup(payload.deviceId);
  ctx.setState((prev) => ({
    deviceConnected: { ...prev.deviceConnected, [payload.deviceId]: false },
  }));
};

const handleDeviceReconnected: DeviceEventHandler = (ctx, payload) => {
  ctx.setState((prev) => ({
    deviceConnected: { ...prev.deviceConnected, [payload.deviceId]: true },
    deviceErrors: { ...prev.deviceErrors, [payload.deviceId]: undefined },
    deviceReconnecting: { ...prev.deviceReconnecting, [payload.deviceId]: undefined },
  }));
};

const deviceEventHandlers = new Map<DeviceEventType, DeviceEventHandler>([
  ['error', handleDeviceError],
  ['disconnected', handleDeviceDisconnected],
  ['reconnected', handleDeviceReconnected],
]);

export function handleDeviceEvent(ctx: TmuxDomainEventContext, payload: EventDevicePayload): void {
  deviceEventHandlers.get(payload.type)?.(ctx, payload);
}

const handleBell: TmuxEventHandler = (ctx, payload) => {
  console.log('[tmex] bell', payload.data);
  const data = eventData(payload);
  const paneId = stringField(data, 'paneId') ?? stringField(data, 'windowId');
  if (paneId) {
    useBellStore.getState().triggerBell(paneId);
  }
  const settings = ctx.getSite().getState().settings;
  if (settings?.enableBellSound !== false) {
    ctx.core.bell.play();
  }
};

function shouldSuppressNotification(ctx: TmuxDomainEventContext): boolean {
  if (ctx.core.features.hostManagedNotifications) {
    return true;
  }
  return ctx.getSite().getState().settings?.enableBrowserNotificationToast === false;
}

const handleNotification: TmuxEventHandler = (ctx, payload) => {
  console.log('[tmex] notification', payload.data);
  if (shouldSuppressNotification(ctx)) {
    return;
  }

  const data = eventData(payload);
  const { title, description } = formatTerminalNotificationToast(data, ctx.core.t);
  const paneUrl = stringField(data, 'paneUrl');
  ctx.core.notifications.info(title, {
    description,
    action: paneUrl
      ? {
          label: 'Open',
          onClick: () => {
            // 服务端下发的是本 node 的绝对 URL；先取 pathname 再套本 runtime 的 node 前缀。
            ctx.core.host.navigate(hostAppPath(ctx.core.host, toAppPath(paneUrl)));
          },
        }
      : undefined,
  });
};

const handlePaneActive: TmuxEventHandler = (ctx, payload) => {
  const data = eventData(payload);
  const windowId = stringField(data, 'windowId');
  const paneId = stringField(data, 'paneId');
  if (!windowId || !paneId) {
    return;
  }
  ctx.setState((prev) => ({
    activePaneFromEvent: {
      ...prev.activePaneFromEvent,
      [payload.deviceId]: { windowId, paneId },
    },
  }));
};

const tmuxEventHandlers = new Map<TmuxEventType, TmuxEventHandler>([
  ['bell', handleBell],
  ['notification', handleNotification],
  ['pane-active', handlePaneActive],
]);

export function handleTmuxEvent(ctx: TmuxDomainEventContext, payload: EventTmuxPayload): void {
  tmuxEventHandlers.get(payload.type)?.(ctx, payload);
}
