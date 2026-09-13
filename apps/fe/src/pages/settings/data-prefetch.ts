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
// 2) 只列 queryFn 能从 `@vibeterm/api-client` 的薄封装直接拿到的标签。面板组件本身绝不 import
//    进来——那会把整块面板代码搬回设置页 chunk，正好抵消掉按标签分块的收益。
//    「节点」「远程访问」两个状态查询的键与 fetcher 因此单独放在 status-queries.ts，
//    hook 与这里共用一份（见该文件的说明）。
//
// queryKey 与 fetcher 都直接复用现成导出，不另抄一份端点字符串：
// 抄错了会往同一个 key 里写进形状不同的数据，比慢更糟。
//
// 每个标签预取哪些查询，由 `settings-prefetch.ts` 给出；`settings-tabs.ts` 的 `prefetch`
// 字段指向同一组函数。本文件被侧栏静态引入，因此不能再静态 import 带 i18n key 的注册表。

import type { QueryClient } from '@tanstack/react-query';
import { type ApiClient, SELF_NODE_ID } from '@vibeterm/api-client';
import {
  PREFETCHABLE_TABS,
  SETTINGS_STALE_MS,
  SITE_SETTINGS_QUERY_KEY,
  type TabPrefetchSpec,
  tabPrefetchSpecsFor,
} from './settings-prefetch';

export { PREFETCHABLE_TABS, SETTINGS_STALE_MS, SITE_SETTINGS_QUERY_KEY, type TabPrefetchSpec };

/**
 * 该标签值得在悬停时预取的查询；没有可安全预取的返回空数组。
 * 错误兜底文案与面板里那份不同无所谓：预取失败不写缓存，面板自己重发时会用自己的文案。
 */
export function tabPrefetchSpecs(
  tab: string,
  apiClient: ApiClient,
  nodeId: string = SELF_NODE_ID
): TabPrefetchSpec[] {
  return tabPrefetchSpecsFor(tab, apiClient, nodeId);
}

/**
 * 预取一个标签的数据。`done` 记已经预取过的标签：鼠标扫过标签栏不该把请求发好几遍。
 * prefetchQuery 自身不抛错（失败只是不写缓存），面板挂载时会照常自己发一轮。
 */
export function prefetchTabData(
  queryClient: QueryClient,
  tab: string,
  apiClient: ApiClient,
  done: Set<string>,
  nodeId: string = SELF_NODE_ID
): void {
  if (done.has(tab)) return;
  const specs = tabPrefetchSpecs(tab, apiClient, nodeId);
  if (specs.length === 0) return;
  done.add(tab);
  for (const spec of specs) {
    void queryClient.prefetchQuery(spec).catch(() => undefined);
  }
}

/** 设置入口悬停：拉 general 的 chunk，并预取站点设置（与标签栏 nodes/remoteAccess 同一套）。 */
export function prefetchSettingsLanding(
  queryClient: QueryClient,
  apiClient: ApiClient,
  done: Set<string>,
  nodeId: string = SELF_NODE_ID
): void {
  void import('./general-settings-tab').catch(() => undefined);
  prefetchTabData(queryClient, 'general', apiClient, done, nodeId);
}
