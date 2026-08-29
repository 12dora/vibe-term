// 设备事件与 tmux 事件（bell / notification / pane-active）的状态与副作用处理。

import { formatTerminalNotificationToast, useBellStore } from '@tmex/notifications';
import type { EventDevicePayload, EventTmuxPayload, TmuxEventType } from '@tmex/shared';
import type { RuntimeCore } from './runtime';
import type { SiteStore } from './site';
import type { TmuxGetState, TmuxSetState } from './tmux-state';

export interface TmuxDomainEventContext {
  core: RuntimeCore;
  getState: TmuxGetState;
  setState: TmuxSetState;
  getSite: () => SiteStore;
}

export function handleDeviceEvent(ctx: TmuxDomainEventContext, payload: EventDevicePayload): void {
  if (payload.type === 'error') {
    const summary = payload.message ?? 'Device Error';
    const errorType = payload.errorType ?? 'unknown';

    if (errorType === 'reconnecting') {
      ctx.setState((prev) => ({
        deviceReconnecting: {
          ...prev.deviceReconnecting,
          [payload.deviceId]: { message: summary, at: Date.now() },
        },
      }));
      return;
    }

    const previousError = ctx.getState().deviceErrors[payload.deviceId];
    const shouldToast = !previousError || previousError.type !== errorType;

    ctx.setState((prev) => ({
      deviceErrors: {
        ...prev.deviceErrors,
        [payload.deviceId]: {
          message: summary,
          type: errorType,
          rawMessage: payload.rawMessage,
          at: Date.now(),
        },
      },
      deviceReconnecting: { ...prev.deviceReconnecting, [payload.deviceId]: undefined },
    }));

    // 宿主接管通知呈现时设备错误 toast 一并让位；deviceErrors 状态照写（错误横幅等 UI 状态不受影响）
    if (shouldToast && !ctx.core.features.hostManagedNotifications) {
      ctx.core.notifications.error(summary);
    }

    return;
  }

  if (payload.type === 'disconnected') {
    ctx.core.selectMachine().cleanup(payload.deviceId);
    ctx.setState((prev) => ({
      deviceConnected: { ...prev.deviceConnected, [payload.deviceId]: false },
    }));
    return;
  }

  if (payload.type === 'reconnected') {
    ctx.setState((prev) => ({
      deviceConnected: { ...prev.deviceConnected, [payload.deviceId]: true },
      deviceErrors: { ...prev.deviceErrors, [payload.deviceId]: undefined },
      deviceReconnecting: { ...prev.deviceReconnecting, [payload.deviceId]: undefined },
    }));
  }
}

type TmuxEventHandler = (ctx: TmuxDomainEventContext, payload: EventTmuxPayload) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' ? value : undefined;
}

function handleBellEvent(ctx: TmuxDomainEventContext, payload: EventTmuxPayload): void {
  console.log('[tmex] bell', payload.data);
  const data = toRecord(payload.data);
  const paneId = readString(data, 'paneId') ?? readString(data, 'windowId');
  if (paneId) {
    useBellStore.getState().triggerBell(paneId);
  }
  if (ctx.getSite().getState().settings?.enableBellSound !== false) {
    ctx.core.bell.play();
  }
}

function handleNotificationEvent(ctx: TmuxDomainEventContext, payload: EventTmuxPayload): void {
  console.log('[tmex] notification', payload.data);
  if (ctx.core.features.hostManagedNotifications) {
    return;
  }
  if (ctx.getSite().getState().settings?.enableBrowserNotificationToast === false) {
    return;
  }

  const data = toRecord(payload.data);
  const { title, description } = formatTerminalNotificationToast(data, ctx.core.t);
  const paneUrl = readString(data, 'paneUrl');
  ctx.core.notifications.info(title, {
    description,
    action: paneUrl
      ? {
          label: 'Open',
          onClick: () => {
            ctx.core.host.navigate(paneUrl);
          },
        }
      : undefined,
  });
}

function handlePaneActiveEvent(ctx: TmuxDomainEventContext, payload: EventTmuxPayload): void {
  const data = toRecord(payload.data);
  const windowId = readString(data, 'windowId');
  const paneId = readString(data, 'paneId');
  if (!windowId || !paneId) {
    return;
  }
  ctx.setState((prev) => ({
    activePaneFromEvent: {
      ...prev.activePaneFromEvent,
      [payload.deviceId]: { windowId, paneId },
    },
  }));
}

const TMUX_EVENT_HANDLERS: Partial<Record<TmuxEventType, TmuxEventHandler>> = {
  bell: handleBellEvent,
  notification: handleNotificationEvent,
  'pane-active': handlePaneActiveEvent,
};

export function handleTmuxEvent(ctx: TmuxDomainEventContext, payload: EventTmuxPayload): void {
  TMUX_EVENT_HANDLERS[payload.type]?.(ctx, payload);
}
