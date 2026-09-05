// 设置页标签的数据预取。
//
// chunk 预热（chunk-preload.ts）只消掉了「下载代码」那一段，面板挂载后还要再发一轮请求。
// 这里把其中一部分提前到指针悬停/触摸的那一刻——从悬停到点下通常几百毫秒，
// 够一发 GET 打个来回，面板挂载时缓存已经就位，直接出内容而不是先转圈。
//
// 两条刻意的边界：
//
// 1) 只在悬停时预取，不跟着空闲预热一起做。全局 QueryClient 的 staleTime 只有 5 秒
//    （node-runtimes.ts），进页面就把七个标签的数据全拉一遍，等用户真点进去多半已经过期，
//    白发十来个请求还要跟当前标签自己的 chunk / 请求抢带宽——隧道场景下得不偿失。
//    悬停是高意图信号，窗口又短，正好落在 staleTime 内。
//
// 2) 只列 queryFn 能从 `@tmex/api-client` 的薄封装直接拿到的标签。面板组件本身绝不 import
//    进来——那会把整块面板代码搬回设置页 chunk，正好抵消掉按标签分块的收益。
//    「节点」「远程访问」两个状态查询的键与 fetcher 因此单独放在 status-queries.ts，
//    hook 与这里共用一份（见该文件的说明）。
//
// queryKey 与 fetcher 都直接复用现成导出，不另抄一份端点字符串：
// 抄错了会往同一个 key 里写进形状不同的数据，比慢更糟。

import type { QueryClient } from '@tanstack/react-query';
import {
  type ApiClient,
  fetchAgentLlmSettings,
  fetchLlmProviders,
  fetchTerminalShortcuts,
  llmProvidersQueryKey,
  llmSettingsQueryKey,
  terminalShortcutsQueryKey,
} from '@tmex/api-client';
import { listShares, shareQueryKey } from '@tmex/api-client/share';
import {
  LOCAL_STATUS_QUERY_KEY,
  TLS_STATUS_QUERY_KEY,
  TUNNEL_STATUS_QUERY_KEY,
  fetchSelfLocalStatus,
  fetchSelfTlsStatus,
  fetchSelfTunnelStatus,
} from './status-queries';

/**
 * 设置类数据（站点设置、快捷键、模型、通知渠道、文件根……）的缓存窗口。
 * 这些数据只在用户自己保存时才变，全局默认的 5 秒太短：切走再切回来必然重发一轮。
 * 实时状态（隧道 / 本机运行态 / TLS）不用这个值，它们各自带轮询。
 */
export const SETTINGS_STALE_MS = 30_000;

export interface TabPrefetchSpec {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  /** 缓存足够新就不重发。不填走 QueryClient 的默认值（5 秒），适合实时状态。 */
  staleTime?: number;
}

/**
 * 该标签值得在悬停时预取的查询；没有可安全预取的返回空数组。
 * 错误兜底文案与面板里那份不同无所谓：预取失败不写缓存，面板自己重发时会用自己的文案。
 */
export function tabPrefetchSpecs(tab: string, apiClient: ApiClient): TabPrefetchSpec[] {
  if (tab === 'ai') {
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
  if (tab === 'terminal') {
    return [
      {
        queryKey: terminalShortcutsQueryKey,
        queryFn: () => fetchTerminalShortcuts(apiClient),
        staleTime: SETTINGS_STALE_MS,
      },
    ];
  }
  // 这两个标签的首屏都被状态接口整块挡住（远程访问要等隧道探测，节点要等本机运行态 / TLS），
  // 也正是最值得抢在点击之前发出去的。它们问的是本机，不吃 `apiClient`（见 status-queries.ts）。
  if (tab === 'remoteAccess') {
    return [{ queryKey: TUNNEL_STATUS_QUERY_KEY, queryFn: fetchSelfTunnelStatus }];
  }
  if (tab === 'nodes') {
    return [
      { queryKey: LOCAL_STATUS_QUERY_KEY, queryFn: fetchSelfLocalStatus },
      { queryKey: TLS_STATUS_QUERY_KEY, queryFn: fetchSelfTlsStatus },
    ];
  }
  // 分享列表带在线人数与剩余期限，自身每 10 秒一拍：预取只为消掉首屏那一转，不给 staleTime。
  if (tab === 'share') {
    return [{ queryKey: shareQueryKey(), queryFn: () => listShares(apiClient) }];
  }
  return [];
}

/** 能预取的标签，供测试与调用方判断（避免为没有 spec 的标签白跑一趟）。 */
export const PREFETCHABLE_TABS: readonly string[] = [
  'ai',
  'terminal',
  'nodes',
  'remoteAccess',
  'share',
];

/**
 * 预取一个标签的数据。`done` 记已经预取过的标签：鼠标扫过标签栏不该把请求发好几遍。
 * prefetchQuery 自身不抛错（失败只是不写缓存），面板挂载时会照常自己发一轮。
 */
export function prefetchTabData(
  queryClient: QueryClient,
  tab: string,
  apiClient: ApiClient,
  done: Set<string>
): void {
  if (done.has(tab)) return;
  const specs = tabPrefetchSpecs(tab, apiClient);
  if (specs.length === 0) return;
  done.add(tab);
  for (const spec of specs) {
    void queryClient.prefetchQuery(spec).catch(() => undefined);
  }
}
