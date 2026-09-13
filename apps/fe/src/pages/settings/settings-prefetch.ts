// 设置标签的悬停预取清单。与 `settings-tabs.ts` 的 `prefetch` 字段共用这些函数。
//
// 本文件**不能**出现 i18n key 字面量：`data-prefetch.ts` 被侧栏标题静态引入，
// 会进入入口 chunk 的 core 语言包覆盖图（见 `core-coverage.test.tsx`）。

import {
  type ApiClient,
  fetchAgentLlmSettings,
  fetchLlmProviders,
  fetchSiteSettings,
  fetchTerminalShortcuts,
  llmProvidersQueryKey,
  llmSettingsQueryKey,
  terminalShortcutsQueryKey,
} from '@vibeterm/api-client';
import { listShares, shareNodeQueryKey } from '@vibeterm/api-client/share';
import {
  LOCAL_STATUS_QUERY_KEY,
  TLS_STATUS_QUERY_KEY,
  TUNNEL_STATUS_QUERY_KEY,
  fetchSelfLocalStatus,
  fetchSelfTlsStatus,
  fetchSelfTunnelStatus,
} from './status-queries';

export const SETTINGS_STALE_MS = 30_000;
export const SITE_SETTINGS_QUERY_KEY = ['site-settings'] as const;

export interface TabPrefetchSpec {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  /** 缓存足够新就不重发。不填走 QueryClient 的默认值（5 秒），适合实时状态。 */
  staleTime?: number;
}

export type TabPrefetchFn = (apiClient: ApiClient, nodeId: string) => TabPrefetchSpec[];

export function prefetchSiteSettings(apiClient: ApiClient): TabPrefetchSpec[] {
  return [
    {
      queryKey: SITE_SETTINGS_QUERY_KEY,
      queryFn: () => fetchSiteSettings(apiClient),
      staleTime: SETTINGS_STALE_MS,
    },
  ];
}

export function prefetchAiSettings(apiClient: ApiClient): TabPrefetchSpec[] {
  return [
    {
      queryKey: llmProvidersQueryKey,
      queryFn: () => fetchLlmProviders(undefined, apiClient),
      staleTime: SETTINGS_STALE_MS,
    },
    {
      queryKey: llmSettingsQueryKey,
      queryFn: () => fetchAgentLlmSettings(undefined, apiClient),
      staleTime: SETTINGS_STALE_MS,
    },
  ];
}

export function prefetchTerminalSettings(apiClient: ApiClient): TabPrefetchSpec[] {
  return [
    {
      queryKey: terminalShortcutsQueryKey,
      queryFn: () => fetchTerminalShortcuts(apiClient),
      staleTime: SETTINGS_STALE_MS,
    },
  ];
}

export function prefetchRemoteAccess(): TabPrefetchSpec[] {
  return [{ queryKey: TUNNEL_STATUS_QUERY_KEY, queryFn: fetchSelfTunnelStatus }];
}

export function prefetchNodes(): TabPrefetchSpec[] {
  return [
    { queryKey: LOCAL_STATUS_QUERY_KEY, queryFn: fetchSelfLocalStatus },
    { queryKey: TLS_STATUS_QUERY_KEY, queryFn: fetchSelfTlsStatus },
  ];
}

export function prefetchShare(apiClient: ApiClient, nodeId: string): TabPrefetchSpec[] {
  return [{ queryKey: shareNodeQueryKey(nodeId), queryFn: () => listShares(apiClient) }];
}

const PREFETCHERS: Record<string, TabPrefetchFn> = {
  general: prefetchSiteSettings,
  ai: prefetchAiSettings,
  terminal: prefetchTerminalSettings,
  remoteAccess: prefetchRemoteAccess,
  nodes: prefetchNodes,
  share: prefetchShare,
};

export const PREFETCHABLE_TABS: readonly string[] = Object.keys(PREFETCHERS);

export function tabPrefetchSpecsFor(
  tab: string,
  apiClient: ApiClient,
  nodeId: string
): TabPrefetchSpec[] {
  return PREFETCHERS[tab]?.(apiClient, nodeId) ?? [];
}
