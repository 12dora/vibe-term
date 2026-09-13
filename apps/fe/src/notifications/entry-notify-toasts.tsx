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
//   - `agent_*` 由发起机上报（远端 agent 会话的事件天然带 nodeId），不属于转发，排除。
//
// 与「来源节点自己的运行时」之间**不按路由排除**：浏览器是不是订阅着那台机器无从假设
//（另一个浏览器持着订阅、懒登录门闸还没放行、刚离开那条路由但运行时还在宽限期都可能），
// 排除掉就会漏弹或弹两遍。改成按事件身份认领（`@vibeterm/notifications` 的 toast-dedupe）：
// 直投与转发谁先到谁弹，另一条丢掉。

import { getMeshNodesState } from '@/node/mesh-nodes';
import { isValidNodeId, nodeAppPath } from '@vibeterm/api-client';
import { buildPaneLocationLabel, claimToastFor } from '@vibeterm/notifications';
import type { ToastIdentity } from '@vibeterm/notifications';
import type { WebhookEvent } from '@vibeterm/shared';
import { wsBorsh } from '@vibeterm/shared';
import { encodePaneIdForUrl } from '@vibeterm/stores';
import type { AppRuntime } from '@vibeterm/stores';
import { useRuntime } from '@vibeterm/stores/react';
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
  return true;
}

/** 转发件的事件身份：与来源机直投那一路（`WATCH_EVENT` / tmux `notification`）同一组 id。 */
export function forwardedToastIdentity(
  eventType: string,
  event: WebhookEvent,
  origin: ForwardedOrigin
): ToastIdentity {
  const ruleId = event.payload?.ruleId;
  return {
    eventType,
    nodeId: origin.nodeId,
    deviceId: event.device?.id ?? null,
    paneId: event.tmux?.paneId ?? null,
    ruleId: typeof ruleId === 'string' ? ruleId : null,
  };
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
        entryNodeId: deps.entryNodeId(),
        hostManagedNotifications: runtime.features.hostManagedNotifications,
        toastEnabled,
      })
    ) {
      return;
    }

    const origin = forwardedOrigin(decoded.event) as ForwardedOrigin;
    if (!claimToastFor(forwardedToastIdentity(decoded.eventType, decoded.event, origin))) return;

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
                // path 已是 `/n/<来源>/...` 宿主路由形状，不能再过 hostAppPath（当前运行时若是来源节点会叠成双前缀）。
                runtime.host.navigate(path);
                runtime.host.closeMobileSidebar();
              },
            },
          }
        : {}),
    });
  });
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
        t: (key, params) => i18next.t(key, params ?? {}) as string,
      }),
    [runtime]
  );
  return null;
}
