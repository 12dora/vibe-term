// WATCH_EVENT 全局通知接线（模式仿 stores/tmux.ts：模块级 initialized 防重 + client.onMessage 独立 handler）。
// 挂在 RootLayout，只负责 toast / 浏览器 Notification / react-query 失效，不持有渲染状态。

import i18next from 'i18next';
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
import { defaultRuntime, navigateToAppUrl } from '@tmex/stores';
import { useTmuxStore } from '@tmex/stores';
import { encodePaneIdForUrl } from '@tmex/stores';
import { getBorshClient } from '@tmex/ws-client';
import { useEffect } from 'react';

let initialized = false;

function buildPaneUrl(deviceId: string, paneId: string, windowId?: string): string {
  let targetWindowId = windowId;
  if (!targetWindowId) {
    const windows = useTmuxStore.getState().snapshots[deviceId]?.session?.windows;
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

async function resolveRuleName(queryClient: QueryClient, ruleId: string): Promise<string | null> {
  const cached = findCachedRuleName(queryClient, ruleId);
  if (cached) {
    return cached;
  }
  try {
    const rule = await fetchWatchRule(ruleId);
    return rule?.name ?? null;
  } catch {
    return null;
  }
}

function notifyBrowser(title: string, body: string, url: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return;
  }
  try {
    const notification = new Notification(title, { body });
    notification.onclick = () => {
      window.focus();
      navigateToAppUrl(url);
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
  queryClient: QueryClient,
  ruleId: string,
  deviceId: string,
  paneId: string,
  payload: WatchTriggeredPayload
): Promise<void> {
  const ruleName = await resolveRuleName(queryClient, ruleId);
  const { title, description } = formatWatchTriggeredNotification(ruleName, payload, i18next.t);
  const url = buildPaneUrl(deviceId, paneId, payload.windowId);

  defaultRuntime.notifications.info(title, {
    description,
    action: {
      label: i18next.t('watch.toast.openTerminal'),
      onClick: () => {
        navigateToAppUrl(url);
      },
    },
  });
  notifyBrowser(title, description, url);
}

function setupWatchEventHandlers(queryClient: QueryClient): void {
  if (initialized) {
    return;
  }
  initialized = true;

  const client = getBorshClient();
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
          queryClient,
          decoded.ruleId,
          decoded.deviceId,
          decoded.paneId,
          payload as WatchTriggeredPayload
        );
        return;
      case wsBorsh.WATCH_EVENT_MODEL_UNAVAILABLE: {
        const data = payload as WatchModelUnavailablePayload;
        defaultRuntime.notifications.warning(i18next.t('watch.toast.modelUnavailableTitle'), {
          description: `${data.message} ${i18next.t('watch.toast.modelUnavailableHint')}`,
        });
        return;
      }
      case wsBorsh.WATCH_EVENT_RULE_ERROR: {
        const data = payload as WatchRuleErrorPayload;
        defaultRuntime.notifications.error(i18next.t('watch.toast.ruleErrorTitle'), {
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
  const ensureSocketConnected = useTmuxStore((s) => s.ensureSocketConnected);

  useEffect(() => {
    setupWatchEventHandlers(queryClient);
    ensureSocketConnected();
  }, [queryClient, ensureSocketConnected]);

  return null;
}
