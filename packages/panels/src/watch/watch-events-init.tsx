// WATCH_EVENT 全局通知接线（按 client 防重：WeakSet 保证同一连接只注册一次，多 runtime 各自注册）。
// 挂在 RootLayout，只负责 toast / 浏览器 Notification / react-query 失效，不持有渲染状态。

import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { fetchWatchRule } from '@tmex/api-client';
import { formatWatchTriggeredNotification } from '@tmex/notifications';
import type {
  WatchModelUnavailablePayload,
  WatchRuleDto,
  WatchRuleErrorPayload,
  WatchTriggeredPayload,
} from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import type { AppRuntime } from '@tmex/stores';
import { encodePaneIdForUrl, hostAppPath } from '@tmex/stores';
import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import type { BorshWebSocketClient } from '@tmex/ws-client';
import i18next from 'i18next';
import { useEffect } from 'react';

const initializedClients = new WeakSet<BorshWebSocketClient>();

// 与 stores/app-navigation.ts 的 PANE_URL_RE 同款：不锚定开头（宿主路由可能带前缀）。
const PANE_URL_RE = /\/devices\/([^/]+)\/windows\/([^/]+)\/panes\/([^/]+)$/;

// 「sidebar device list 点击同款」跳转语义（与 stores/app-navigation.ts 保持一致）：
// pane 路由先 dispatch tmex:user-initiated-selection（2s 内防自动跟踪覆盖该选择）再导航（replace）。
// detail 里的 paneId 与 sidebar navigateToPane 保持一致：原始未编码值。
function navigateToWatchUrl(runtime: AppRuntime, url: string): void {
  const match = PANE_URL_RE.exec(url);
  if (match) {
    const [, deviceId, windowId, encodedPaneId] = match;
    window.dispatchEvent(
      new CustomEvent('tmex:user-initiated-selection', {
        detail: { deviceId, windowId, paneId: decodeURIComponent(encodedPaneId) },
      })
    );
  }
  runtime.host.navigate(hostAppPath(runtime.host, url), { replace: true });
  runtime.host.closeMobileSidebar();
}

function buildPaneUrl(
  runtime: AppRuntime,
  deviceId: string,
  paneId: string,
  windowId?: string
): string {
  let targetWindowId = windowId;
  if (!targetWindowId) {
    const windows = runtime.stores.tmux.getState().snapshots[deviceId]?.session?.windows;
    targetWindowId = windows?.find((win) => win.panes.some((pane) => pane.id === paneId))?.id;
  }
  if (!targetWindowId) {
    return `/devices/${deviceId}`;
  }
  return `/devices/${deviceId}/windows/${targetWindowId}/panes/${encodePaneIdForUrl(paneId)}`;
}

function findCachedRuleName(queryClient: QueryClient, ruleId: string): string | null {
  const entries = queryClient.getQueriesData<WatchRuleDto[]>({ queryKey: ['watch-rules'] });
  for (const [, rules] of entries) {
    const found = rules?.find((rule) => rule.id === ruleId);
    if (found) {
      return found.name;
    }
  }
  return null;
}

async function resolveRuleName(
  runtime: AppRuntime,
  queryClient: QueryClient,
  ruleId: string
): Promise<string | null> {
  const cached = findCachedRuleName(queryClient, ruleId);
  if (cached) {
    return cached;
  }
  try {
    const rule = await fetchWatchRule(ruleId, runtime.apiClient);
    return rule?.name ?? null;
  } catch {
    return null;
  }
}

function notifyBrowser(runtime: AppRuntime, title: string, body: string, url: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return;
  }
  try {
    const notification = new Notification(title, { body });
    notification.onclick = () => {
      window.focus();
      navigateToWatchUrl(runtime, url);
    };
  } catch {
    // 部分平台（如未注册 SW 的移动端）构造 Notification 会抛错，静默降级为 toast
  }
}

function invalidateWatchQueries(queryClient: QueryClient, ruleId: string): void {
  void queryClient.invalidateQueries({ queryKey: ['watch-rules'] });
  void queryClient.invalidateQueries({ queryKey: ['watch-rule-state', ruleId] });
}

async function handleTriggered(
  runtime: AppRuntime,
  queryClient: QueryClient,
  ruleId: string,
  deviceId: string,
  paneId: string,
  payload: WatchTriggeredPayload
): Promise<void> {
  const ruleName = await resolveRuleName(runtime, queryClient, ruleId);
  const { title, description } = formatWatchTriggeredNotification(ruleName, payload, i18next.t);
  const url = buildPaneUrl(runtime, deviceId, paneId, payload.windowId);

  runtime.notifications.info(title, {
    description,
    action: {
      label: i18next.t('watch.toast.openTerminal'),
      onClick: () => {
        navigateToWatchUrl(runtime, url);
      },
    },
  });
  notifyBrowser(runtime, title, description, url);
}

function setupWatchEventHandlers(runtime: AppRuntime, queryClient: QueryClient): void {
  const client = runtime.client;
  if (initializedClients.has(client)) {
    return;
  }
  initializedClients.add(client);

  client.onMessage((msg) => {
    if (msg.kind !== wsBorsh.KIND_WATCH_EVENT) {
      return;
    }

    let decoded: {
      ruleId: string;
      deviceId: string;
      paneId: string;
      eventType: number;
      payload: Uint8Array;
    };
    try {
      decoded = wsBorsh.decodePayload(wsBorsh.schema.WatchEventSchema, msg.payload);
    } catch (error) {
      console.error('[watch] failed to decode WATCH_EVENT:', error);
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(decoded.payload));
    } catch (error) {
      console.error('[watch] failed to parse WATCH_EVENT payload:', error);
      return;
    }

    invalidateWatchQueries(queryClient, decoded.ruleId);

    switch (decoded.eventType) {
      case wsBorsh.WATCH_EVENT_TRIGGERED:
        void handleTriggered(
          runtime,
          queryClient,
          decoded.ruleId,
          decoded.deviceId,
          decoded.paneId,
          payload as WatchTriggeredPayload
        );
        return;
      case wsBorsh.WATCH_EVENT_MODEL_UNAVAILABLE: {
        const data = payload as WatchModelUnavailablePayload;
        runtime.notifications.warning(i18next.t('watch.toast.modelUnavailableTitle'), {
          description: `${data.message} ${i18next.t('watch.toast.modelUnavailableHint')}`,
        });
        return;
      }
      case wsBorsh.WATCH_EVENT_RULE_ERROR: {
        const data = payload as WatchRuleErrorPayload;
        runtime.notifications.error(i18next.t('watch.toast.ruleErrorTitle'), {
          description: data.message,
        });
        return;
      }
      default:
        return;
    }
  });
}

export function WatchEventsInit() {
  const queryClient = useQueryClient();
  const runtime = useRuntime();
  const ensureSocketConnected = useTmuxStore((s) => s.ensureSocketConnected);

  useEffect(() => {
    setupWatchEventHandlers(runtime, queryClient);
    ensureSocketConnected();
  }, [runtime, queryClient, ensureSocketConnected]);

  return null;
}
