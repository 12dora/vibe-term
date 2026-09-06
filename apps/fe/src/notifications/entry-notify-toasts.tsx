// 入口机（self）上的「其它节点事件」toast。
//
// 背景：通知事件由**产生它的那台机器**的 EventNotifier 分发，浏览器侧的 toast 也一直只来自
// 当前路由 node 的运行时（bell / terminal notification 走 tmux 事件，watch 走 WATCH_EVENT）。
// 多节点通知落地后，节点会把事件转发给汇聚点，汇聚点再经自己的通道发出——其中给浏览器的那一路
// 是 `/ws` 的 `KIND_NOTIFY_EVENT` 广播，而 web 前端此前**没有任何消费方**（它原本只服务于
// 接管通知呈现的原生宿主）。本模块把这一路接到入口机的运行时上，且不随路由 node 切换。
//
// 只弹「别人家」的事件：
//   - payload 里没有 nodeId 的是本机自己的事件，既有通道已经弹过；
//   - 来源就是入口自身的同理；
//   - 来源正是当前路由 node 时，那台机器的运行时已经弹过，避免弹两遍；
//   - `agent_*` 由发起机上报（远端 agent 会话的事件天然带 nodeId），不属于转发，排除。

import { getMeshNodesState } from '@/node/mesh-nodes';
import { isValidNodeId, nodeAppPath, parseNodeIdFromPath } from '@tmex/api-client';
import { buildPaneLocationLabel } from '@tmex/notifications';
import type { WebhookEvent } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { encodePaneIdForUrl, hostAppPath } from '@tmex/stores';
import type { AppRuntime } from '@tmex/stores';
import { useRuntime } from '@tmex/stores/react';
import i18next from 'i18next';
import { useEffect } from 'react';

type Translate = (key: string, params?: Record<string, unknown>) => string;

export interface ForwardedOrigin {
  nodeId: string;
  nodeName: string | null;
}

/** 事件的来源节点；本机自产的事件没有这一段。 */
export function forwardedOrigin(event: WebhookEvent): ForwardedOrigin | null {
  const payload = event.payload ?? {};
  const nodeId = typeof payload.nodeId === 'string' ? payload.nodeId.trim() : '';
  if (!nodeId) return null;
  const name = typeof payload.nodeName === 'string' ? payload.nodeName.trim() : '';
  return { nodeId, nodeName: name || null };
}

export interface ForwardedToastContext {
  eventType: string;
  event: WebhookEvent;
  /** 当前路由 node（已解析为具体 node id；入口自身为 entryNodeId）。 */
  routeNodeId: string | null;
  entryNodeId: string | null;
  hostManagedNotifications: boolean;
  toastEnabled: boolean;
}

export function shouldToastForwardedEvent(ctx: ForwardedToastContext): boolean {
  if (!ctx.toastEnabled || ctx.hostManagedNotifications) return false;
  if (ctx.eventType.startsWith('agent_')) return false;
  const origin = forwardedOrigin(ctx.event);
  if (!origin) return false;
  if (ctx.entryNodeId && origin.nodeId === ctx.entryNodeId) return false;
  if (ctx.routeNodeId && origin.nodeId === ctx.routeNodeId) return false;
  return true;
}

/** 事件在来源节点上的应用内路径；拼不出（无设备）时返回 null。 */
export function forwardedEventPath(event: WebhookEvent, origin: ForwardedOrigin): string | null {
  const deviceId = event.device?.id;
  if (!deviceId || deviceId === '-' || !isValidNodeId(origin.nodeId)) return null;
  const windowId = event.tmux?.windowId;
  const paneId = event.tmux?.paneId;
  const path =
    windowId && paneId
      ? `/devices/${encodeURIComponent(deviceId)}/windows/${encodeURIComponent(
          windowId
        )}/panes/${encodePaneIdForUrl(paneId)}`
      : `/devices/${encodeURIComponent(deviceId)}`;
  return nodeAppPath(origin.nodeId, path);
}

const DETAIL_KEYS = ['message', 'body', 'title', 'text', 'summary', 'reason'] as const;

function eventDetail(event: WebhookEvent): string {
  const payload = event.payload ?? {};
  for (const key of DETAIL_KEYS) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function formatForwardedEventToast(
  eventType: string,
  event: WebhookEvent,
  origin: ForwardedOrigin,
  t: Translate
): { title: string; description: string } {
  const title = t(`notification.eventType.${eventType}`, { defaultValue: eventType });
  const lines = [
    t('notification.mesh.origin', {
      node: origin.nodeName ?? origin.nodeId.slice(0, 8),
      device: event.device?.name || '—',
    }),
  ];
  const location = buildPaneLocationLabel({ ...(event.tmux ?? {}) }, t);
  if (location) lines.push(location);
  const detail = eventDetail(event);
  if (detail) lines.push(detail);
  return { title, description: lines.join('\n') };
}

function decodeNotifyEvent(payload: Uint8Array): { eventType: string; event: WebhookEvent } | null {
  try {
    const decoded = wsBorsh.decodePayload(wsBorsh.schema.EventNotifyS2CSchema, payload);
    return {
      eventType: decoded.eventType,
      event: JSON.parse(decoded.eventJson) as WebhookEvent,
    };
  } catch (error) {
    console.error('[notify] failed to decode NOTIFY_EVENT:', error);
    return null;
  }
}

export interface EntryNotifyDeps {
  /** 当前路由 node（`self` 已解析成 entry 自身的 node id）。 */
  routeNodeId: () => string | null;
  entryNodeId: () => string | null;
  t: Translate;
}

export function subscribeEntryNotifyToasts(runtime: AppRuntime, deps: EntryNotifyDeps): () => void {
  return runtime.client.onMessage((msg) => {
    if (msg.kind !== wsBorsh.KIND_NOTIFY_EVENT) return;
    const decoded = decodeNotifyEvent(msg.payload);
    if (!decoded) return;

    const toastEnabled =
      runtime.stores.site.getState().settings?.enableBrowserNotificationToast !== false;
    if (
      !shouldToastForwardedEvent({
        eventType: decoded.eventType,
        event: decoded.event,
        routeNodeId: deps.routeNodeId(),
        entryNodeId: deps.entryNodeId(),
        hostManagedNotifications: runtime.features.hostManagedNotifications,
        toastEnabled,
      })
    ) {
      return;
    }

    const origin = forwardedOrigin(decoded.event) as ForwardedOrigin;
    const { title, description } = formatForwardedEventToast(
      decoded.eventType,
      decoded.event,
      origin,
      deps.t
    );
    const path = forwardedEventPath(decoded.event, origin);
    runtime.notifications.info(title, {
      description,
      ...(path
        ? {
            action: {
              label: deps.t('watch.toast.openTerminal'),
              onClick: () => {
                runtime.host.navigate(hostAppPath(runtime.host, path));
                runtime.host.closeMobileSidebar();
              },
            },
          }
        : {}),
    });
  });
}

/** 把当前 URL 的路由 node 解析成具体 node id（入口自身回 entryNodeId）。 */
function currentRouteNodeId(entryNodeId: string | null): string | null {
  if (typeof window === 'undefined') return entryNodeId;
  const routeNodeId = parseNodeIdFromPath(window.location.pathname);
  return isValidNodeId(routeNodeId) && routeNodeId !== 'self' ? routeNodeId : entryNodeId;
}

/**
 * 挂在入口（self）运行时下，**不随路由 node 切换**：其它节点的事件永远由入口的连接送达。
 */
export function EntryNotifyToastsInit() {
  const runtime = useRuntime();
  useEffect(
    () =>
      subscribeEntryNotifyToasts(runtime, {
        entryNodeId: () => getMeshNodesState().entryNodeId,
        routeNodeId: () => currentRouteNodeId(getMeshNodesState().entryNodeId),
        t: (key, params) => i18next.t(key, params ?? {}) as string,
      }),
    [runtime]
  );
  return null;
}
