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
// 2) 只列 queryFn 本来就在入口 bundle 里的标签（`@tmex/api-client` 的共享 fetcher）。
//    其余标签的 queryFn 定义在各自的 lazy chunk 内，为了预取把它们静态 import 进来
//    会把那部分代码搬回入口 chunk，正好抵消掉按标签分块的收益。
//
// queryKey 与 fetcher 都直接复用 `@tmex/api-client` 的导出，不另抄一份端点字符串：
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

export interface TabPrefetchSpec {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
}

/**
 * 该标签值得在悬停时预取的查询；没有可安全预取的返回空数组。
 * 错误兜底文案与面板里那份不同无所谓：预取失败不写缓存，面板自己重发时会用自己的文案。
 */
export function tabPrefetchSpecs(tab: string, apiClient: ApiClient): TabPrefetchSpec[] {
  if (tab === 'ai') {
    return [
      { queryKey: llmProvidersQueryKey, queryFn: () => fetchLlmProviders(undefined, apiClient) },
      { queryKey: llmSettingsQueryKey, queryFn: () => fetchAgentLlmSettings(undefined, apiClient) },
    ];
  }
  if (tab === 'terminal') {
    return [
      { queryKey: terminalShortcutsQueryKey, queryFn: () => fetchTerminalShortcuts(apiClient) },
    ];
  }
  return [];
}

/** 能预取的标签，供测试与调用方判断（避免为没有 spec 的标签白跑一趟）。 */
export const PREFETCHABLE_TABS: readonly string[] = ['ai', 'terminal'];

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
