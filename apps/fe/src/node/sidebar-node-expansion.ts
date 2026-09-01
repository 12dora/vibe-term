// 侧栏「一个 node」分节的展开态（终端栏 / 文件栏各一份）。
//
// 为什么单独有这么一层：展开 = 这台 node **在屏上真的被需要**，宿主据此决定挂不挂它的
// `NodeRuntimeScope`——运行时一挂就是一条 Gateway WS + 一轮直连协商
// （`/api/mesh/connection`、`/api/mesh/rtc-config`、`POST /api/rtc/authorize` 加
// RTCPeerConnection 与 2 s 的 `getStats()` 定时器）。手机上挂着几台 node 时，这是开屏与
// 稳态最大的一笔开销，所以折叠的分节一律不建运行时，只用 `/api/mesh/nodes` 投影里的
// 在线 / 链路信息渲染分节头。
//
// 状态存在共享 UI store 的 `sidebarNodeExpansion`（按浏览器持久化，key 见下）：手机与桌面
// 各留各的选择——手机上折叠着省电，桌面上展开过就一直展开，不必每次刷新重点一遍。
// **只记用户显式点过的那些**；没点过的分节走各栏自己的缺省（终端栏折叠、文件栏展开）。

import { useUIStore } from '@tmex/stores/react';
import { useCallback } from 'react';

/** 展开态按侧栏分区隔离：同一台 node 在终端栏与文件栏各有各的折叠状态。 */
export type SidebarSectionScope = 'panes' | 'files';

export function sidebarNodeExpansionKey(scope: SidebarSectionScope, nodeId: string): string {
  return `${scope}:${nodeId}`;
}

/** 用户显式设过的展开态；没设过返回 `undefined`（由调用方的缺省值决定）。 */
export function sidebarSectionExpanded(
  expansion: Record<string, boolean>,
  scope: SidebarSectionScope,
  nodeId: string
): boolean | undefined {
  return expansion[sidebarNodeExpansionKey(scope, nodeId)];
}

/**
 * `defaultExpanded` 是「用户还没表过态」时的取值：终端栏里当前路由所在的 node 缺省展开
 * （它的运行时本来就由路由边界挂着），其余远端 node 缺省折叠；文件栏缺省展开。
 */
export function useSidebarSectionExpanded(
  scope: SidebarSectionScope,
  nodeId: string,
  defaultExpanded: boolean
): [boolean, (expanded: boolean) => void] {
  const key = sidebarNodeExpansionKey(scope, nodeId);
  const stored = useUIStore((state) => state.sidebarNodeExpansion[key]);
  const setSidebarNodeExpansion = useUIStore((state) => state.setSidebarNodeExpansion);
  const setExpanded = useCallback(
    (expanded: boolean) => setSidebarNodeExpansion(key, expanded),
    [key, setSidebarNodeExpansion]
  );
  return [stored ?? defaultExpanded, setExpanded];
}
