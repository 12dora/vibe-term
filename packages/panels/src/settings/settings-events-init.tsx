// SETTINGS_UPDATE 的 react-query 缓存失效接线：网关任一设置命名空间变更后广播，
// 本组件按命名空间失效对应查询，使多端设置改动即时同步。
// site 由 stores/site 自行 refresh，本表额外覆盖 fe 的 ['site-settings'] 查询。

import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { devicesQueryKey, terminalShortcutsQueryKey } from '@tmex/api-client';
import { useRuntime } from '@tmex/stores/react';
import type { GatewayTransport } from '@tmex/ws-client';
import { useEffect } from 'react';

export type SettingsQueryKey = readonly unknown[];

const NO_KEYS: readonly SettingsQueryKey[] = [];

/**
 * 网关 SettingsNamespace（apps/gateway/src/settings/broadcaster.ts）到需失效查询键的映射。
 * 空数组表示该命名空间无 react-query 缓存：theme 走专用的 SITE_THEME_UPDATE 帧，
 * tree-order 由网关随后重发的 tmux 快照覆盖。
 */
export const SETTINGS_NAMESPACE_QUERY_KEYS: ReadonlyMap<string, readonly SettingsQueryKey[]> =
  new Map<string, readonly SettingsQueryKey[]>([
    ['site', [['site-settings']]],
    ['terminal-shortcuts', [terminalShortcutsQueryKey]],
    ['theme', NO_KEYS],
    ['llm', [['llm-providers'], ['llm-settings']]],
    ['file-roots', [['files'], ['terminal-file-links', 'roots']]],
    ['webhooks', [['webhooks']]],
    ['telegram', [['telegram-bots'], ['telegram-bot-chats']]],
    ['weixin', [['weixin-accounts']]],
    ['devices', [devicesQueryKey]],
    ['tree-order', NO_KEYS],
  ]);

export function queryKeysForNamespace(namespace: string): readonly SettingsQueryKey[] {
  return SETTINGS_NAMESPACE_QUERY_KEYS.get(namespace) ?? NO_KEYS;
}

export function subscribeSettingsInvalidation(
  transport: Pick<GatewayTransport, 'onEvent'>,
  queryClient: QueryClient
): () => void {
  return transport.onEvent((event) => {
    if (event.type !== 'settings-update') {
      return;
    }
    for (const queryKey of queryKeysForNamespace(event.namespace)) {
      void queryClient.invalidateQueries({ queryKey });
    }
  });
}

export function SettingsEventsInit() {
  const queryClient = useQueryClient();
  const runtime = useRuntime();

  useEffect(
    () => subscribeSettingsInvalidation(runtime.transport, queryClient),
    [runtime, queryClient]
  );

  return null;
}
