// 设备事件与 tmux 事件（bell / notification / pane-active）的状态与副作用处理。

import { formatTerminalNotificationToast, useBellStore } from '@tmex/notifications';
import type { EventDevicePayload, EventTmuxPayload } from '@tmex/shared';
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

export function handleTmuxEvent(ctx: TmuxDomainEventContext, payload: EventTmuxPayload): void {
  if (payload.type === 'bell') {
    console.log('[tmex] bell', payload.data);
    const data = (payload.data ?? {}) as Record<string, unknown>;
    const paneId =
      (typeof data.paneId === 'string' ? data.paneId : undefined) ??
      (typeof data.windowId === 'string' ? data.windowId : undefined);
    if (paneId) {
      useBellStore.getState().triggerBell(paneId);
    }
    const settings = ctx.getSite().getState().settings;
    if (settings?.enableBellSound !== false) {
      ctx.core.bell.play();
    }
  }

  if (payload.type === 'notification') {
    console.log('[tmex] notification', payload.data);
    if (ctx.core.features.hostManagedNotifications) {
      return;
    }
    const settings = ctx.getSite().getState().settings;
    if (settings?.enableBrowserNotificationToast === false) {
      return;
    }

    const data = (payload.data ?? {}) as Record<string, unknown>;
    const { title, description } = formatTerminalNotificationToast(data, ctx.core.t);
    const paneUrl = typeof data.paneUrl === 'string' ? data.paneUrl : undefined;
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
  }

  if (payload.type === 'pane-active') {
    const data = payload.data as { windowId: string; paneId: string } | undefined;
    if (data?.windowId && data?.paneId) {
      ctx.setState((prev) => ({
        activePaneFromEvent: {
          ...prev.activePaneFromEvent,
          [payload.deviceId]: { windowId: data.windowId, paneId: data.paneId },
        },
      }));
    }
  }
}
