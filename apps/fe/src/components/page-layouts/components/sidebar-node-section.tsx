// 聚合侧边栏里的「一个 node」分节。
//
// 三种形态（设计 §4「侧边栏聚合视图」）：
//   - 在线且已登录：展开时才懒挂该 node 的运行时并渲染真实设备树，每行带 node 徽标；
//     折叠时只留一行分节头（在线态取自 `/api/mesh/nodes` 投影，不需要运行时）；
//   - 在线但未登录：折叠，只给一个「登录」入口，**不**自动登录也**不**建立连接；
//     用户点开才用内存里的会话钥静默登录，登不上再退回「登录此节点」按钮；
//   - 离线：灰显最近一次已知的设备（本地快照优先，其次 node inventory；名字取不到就用
//     device id），不建连接、不发请求。
//
// 三种形态都受同一条门槛约束：远端 node 至少要有一台设备被打开侧边栏显示，整节才出现
// （self 分节不受此限）。登录别的 node 一律走「管理设备」，侧边栏不做未开启 node 的登录入口。
//
// 远端分节缺省折叠（当前路由所在的 node 除外）：挂运行时 = 一条 Gateway WS + 一轮直连协商，
// 见 `@/node/sidebar-node-expansion` 的说明。self 分节不受影响，恒为展开。

import { NodeRuntimeScope } from '@/node/node-runtime-scope';
import { useSidebarSectionExpanded } from '@/node/sidebar-node-expansion';
import { offlineDevices } from '@/pages/devices/device-snapshot-store';
import { SELF_NODE_ID, parseNodeIdFromPath } from '@vibeterm/api-client';
import { useUIStore } from '@vibeterm/stores/react';
import { cn } from '@vibeterm/ui';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { SideBarDeviceListForRuntime } from './sidebar-device-list-runtime';
import { SectionHeader } from './sidebar-node-header';
import {
  type SidebarNodeEntry,
  type SidebarNodeRuntimeSectionProps,
  type SidebarNodeSortable,
  hasSidebarVisibleDeviceForNode,
  sameRuntimeSectionProps,
  selectedDeviceIdForNode,
} from './sidebar-node-model';
import { SidebarNodeOffline } from './sidebar-node-offline';
import { SidebarNodeSignIn } from './sidebar-node-signin';
import { useSectionPresence } from './use-section-presence';

export type { SidebarNodeEntry, SidebarNodeRuntimeSectionProps, SidebarNodeSortable };
export {
  hasSidebarVisibleDeviceForNode,
  inventoryDevices,
  offlineSidebarDevices,
  sameNodeEntry,
  sameRuntimeSectionProps,
  selectedDeviceIdForNode,
  sidebarVisibleDeviceIdsForNode,
} from './sidebar-node-model';
export { claimEagerSignIn, resetEagerSignInForTest } from './sidebar-node-signin';

/**
 * 在线且已登录的分节：挂该 node 的运行时并渲染真实设备树。
 *
 * 分节头交给设备树一起渲染：可见设备数只有挂上该 node 运行时才读得到，
 * 一台都不显示时整节（含分节头）都不该出现。
 */
const SidebarNodeRuntimeSection = memo(function SidebarNodeRuntimeSection({
  node,
  drag,
  disclosure,
}: SidebarNodeRuntimeSectionProps) {
  const { t } = useTranslation();
  const runtimeNodeId = node.runtimeNodeId;
  // 首帧占位：本地快照优先，其次 node inventory。读 localStorage + 解析 JSON，按 node
  // 与 inventory 记一次即可。
  const placeholderDevices = useMemo(
    () => offlineDevices(runtimeNodeId, node.inventory),
    [runtimeNodeId, node.inventory]
  );
  // 恒等的 key 映射：panels 侧的设备树把它带进 `handleDeviceExpandedChange` 的依赖与两条
  // effect 的依赖，每渲染换一个新函数会让每台 DeviceRow 的 memo 全部失效，并对每台可见设备
  // 空跑一次 ensureDeviceSubscribed。
  const expansionKeyFor = useCallback(
    (deviceId: string) => `${runtimeNodeId}:${deviceId}`,
    [runtimeNodeId]
  );
  return (
    <NodeRuntimeScope nodeId={runtimeNodeId}>
      <SideBarDeviceListForRuntime
        section={{
          testId: `sidebar-node-${runtimeNodeId}`,
          header: <SectionHeader node={node} drag={drag} disclosure={disclosure} />,
          keepWhenNoDevices: node.isSelf,
          containerRef: drag?.sortable.setNodeRef,
          containerStyle: drag?.sortable.style,
          containerClassName: drag?.sortable.isDragging ? 'opacity-60' : undefined,
          placeholderDevices,
        }}
        expansionKeyFor={runtimeNodeId === SELF_NODE_ID ? undefined : expansionKeyFor}
        emptyLabel={t('sidebar.node.noDevices')}
      />
    </NodeRuntimeScope>
  );
}, sameRuntimeSectionProps);

/**
 * 折叠着的远端在线分节：只有一行分节头，**不挂运行时**（不建 WS、不发直连协商）。
 *
 * 在线态与节点名都来自 `/api/mesh/nodes` 投影（常驻的 `MeshNodesResident` 在维护），
 * 与该 node 有没有运行时无关，所以折叠期间徽标照常是实时的。
 * 是否出现这一行沿用「至少开过一台设备显示」那条门槛——与未登录形态同一个判据，都不需要运行时。
 */
function SidebarNodeCollapsed({
  node,
  drag,
  onToggle,
}: {
  node: SidebarNodeEntry;
  drag?: SidebarNodeSortable;
  onToggle: () => void;
}) {
  const visibility = useUIStore((state) => state.sidebarDeviceVisibility);
  const selectedDeviceId = selectedDeviceIdForNode(useLocation().pathname, node.runtimeNodeId);
  const present =
    selectedDeviceId !== null || hasSidebarVisibleDeviceForNode(visibility, node.runtimeNodeId);
  const presence = useSectionPresence(present, null);
  if (!presence.rendered) return null;

  return (
    <div
      ref={drag?.sortable.setNodeRef}
      style={drag?.sortable.style}
      data-testid={`sidebar-node-collapsed-${node.runtimeNodeId}`}
      className={cn('space-y-0.5', presence.className, drag?.sortable.isDragging && 'opacity-60')}
    >
      <SectionHeader node={node} drag={drag} disclosure={{ expanded: false, onToggle }} />
    </div>
  );
}

/**
 * 远端在线分节的折叠开关。缺省折叠，当前路由指向的 node 除外——它的运行时本来就由
 * `NodeRuntimeBoundary` 挂着，分节展开不额外要一份连接。
 *
 * 折叠回去时运行时并不会立刻回收：`NodeConnectionManager` 的引用计数归零后还有 30 s 宽限期
 * （`DEFAULT_RELEASE_GRACE_MS`），来回点开点合不会反复拨号。
 */
function SidebarNodeOnline({ node, drag }: { node: SidebarNodeEntry; drag?: SidebarNodeSortable }) {
  const routed = parseNodeIdFromPath(useLocation().pathname) === node.runtimeNodeId;
  const [expanded, setExpanded] = useSidebarSectionExpanded('panes', node.runtimeNodeId, routed);
  // 分节自身每次导航都会重渲染（要跟着路由算 routed），但展开的分节下面挂着整棵设备树：
  // 折叠开关保持恒等，memo 才能把这次重渲染挡在运行时子树之外。
  const toggle = useCallback(() => setExpanded(!expanded), [expanded, setExpanded]);
  const expand = useCallback(() => setExpanded(true), [setExpanded]);
  const disclosure = useMemo(() => ({ expanded, onToggle: toggle }), [expanded, toggle]);

  if (!expanded) {
    return <SidebarNodeCollapsed node={node} drag={drag} onToggle={expand} />;
  }
  return <SidebarNodeRuntimeSection node={node} drag={drag} disclosure={disclosure} />;
}

export function SidebarNodeSection({
  node,
  drag,
}: {
  node: SidebarNodeEntry;
  drag?: SidebarNodeSortable;
}) {
  if (!node.online) {
    return <SidebarNodeOffline node={node} drag={drag} />;
  }

  if (!node.loggedIn) {
    return <SidebarNodeSignIn node={node} drag={drag} />;
  }

  // self 恒展开：浏览器本来就连着 entry，折叠它省不下任何连接，只会让首屏没有设备可点。
  if (node.isSelf || node.runtimeNodeId === SELF_NODE_ID) {
    return <SidebarNodeRuntimeSection node={node} drag={drag} />;
  }

  return <SidebarNodeOnline node={node} drag={drag} />;
}
