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

import { NodeLoginButton } from '@/auth/NodeLoginButton';
import { loginErrorKey } from '@/auth/login-errors';
import { useNodeLoginGate } from '@/auth/use-node-login';
import { NodeRuntimeScope } from '@/node/node-runtime-scope';
import { useSidebarSectionExpanded } from '@/node/sidebar-node-expansion';
import { offlineDevices } from '@/pages/devices/device-snapshot-store';
import { SELF_NODE_ID, nodeAppPath, parseNodeIdFromPath } from '@tmex/api-client';
import {
  NodeBadge,
  type NodeBadgeInfo,
  type SortableRow,
  shouldHideSidebarNodeSection,
} from '@tmex/panels/device-tree';
import { isSidebarDeviceVisible } from '@tmex/stores';
import { useUIStore } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import { ChevronRight, Loader2, Monitor } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, matchPath, useLocation } from 'react-router';
import { SideBarDeviceListForRuntime } from './sidebar-device-list-runtime';
import { useSectionPresence } from './use-section-presence';

/** 分节整体的拖拽接线；未传即不可拖（standalone / 单元测试直接渲染分节时）。 */
export interface SidebarNodeSortable {
  sortable: SortableRow;
  dragHandleLabel: string;
}

export interface SidebarNodeEntry {
  /** mesh 列表里的真实 node id。 */
  id: string;
  /** 路由 / 运行时 id：entry 自身为 `self`（保持旧路由）。 */
  runtimeNodeId: string;
  name: string;
  online: boolean;
  loggedIn: boolean;
  isSelf: boolean;
  inventory: unknown;
}

/** 从 inventory 里取最近一次已知的设备列表（离线 node 的灰显数据）。 */
export function inventoryDevices(inventory: unknown): { id: string; name: string }[] {
  if (!inventory || typeof inventory !== 'object') return [];
  const devices = (inventory as { devices?: unknown }).devices;
  if (!Array.isArray(devices)) return [];
  const out: { id: string; name: string }[] = [];
  for (const item of devices) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { id?: unknown; name?: unknown };
    if (typeof row.id !== 'string') continue;
    out.push({ id: row.id, name: typeof row.name === 'string' ? row.name : row.id });
  }
  return out;
}

/**
 * 当前路由选中的那台设备（限定在给定 node 下）。
 *
 * 在线分节的可见性过滤（`selectSidebarVisibleDevices`）对选中的设备无条件放行；离线分节
 * 读不到 runtime、也没有那个 selector，只能自己从地址栏解析——否则一台默认隐藏的远端设备
 * 在被选中期间只要它的 node 掉线，就会从侧边栏里凭空消失。
 */
export function selectedDeviceIdForNode(pathname: string, runtimeNodeId: string): string | null {
  if (parseNodeIdFromPath(pathname) !== runtimeNodeId) return null;
  const match = matchPath(
    { path: nodeAppPath(runtimeNodeId, '/devices/:deviceId'), end: false },
    pathname
  );
  const raw = match?.params.deviceId;
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * 该 node 下被显式打开了侧边栏显示的设备 id。
 *
 * 未登录 / 离线的 node 读不到它的设备列表（mesh 的 inventory 只带版本号），只能反过来看开关
 * 本身：远端设备缺省隐藏，用户在「管理设备」里打开时才显式写入 `true`，按复合键前缀取一遍即可。
 * 前缀里带分隔符 `:`，`node-a` 与 `node-ab` 这类互为前缀的 id 不会互相带出。
 */
export function sidebarVisibleDeviceIdsForNode(
  visibility: Record<string, boolean>,
  runtimeNodeId: string
): string[] {
  const prefix = `${runtimeNodeId}:`;
  const ids: string[] = [];
  for (const [key, visible] of Object.entries(visibility)) {
    if (visible && key.startsWith(prefix)) ids.push(key.slice(prefix.length));
  }
  return ids;
}

export function hasSidebarVisibleDeviceForNode(
  visibility: Record<string, boolean>,
  runtimeNodeId: string
): boolean {
  return sidebarVisibleDeviceIdsForNode(visibility, runtimeNodeId).length > 0;
}

/**
 * 离线分节要显示的设备行。
 *
 * 已知设备（本地快照优先，其次 node inventory）按可见性过滤；此外**显式打开过显示、但已知
 * 列表里没有**的设备也要留一行（拿不到名字就用 device id）——mesh 的 inventory 不带设备列表，
 * 只按已知列表过滤会让刚在「管理设备」里打开的远端设备随节点掉线一起从侧边栏消失。
 */
export function offlineSidebarDevices(
  visibility: Record<string, boolean>,
  runtimeNodeId: string,
  knownDevices: { id: string; name: string }[],
  selectedDeviceId: string | null
): { id: string; name: string }[] {
  const names = new Map(knownDevices.map((device) => [device.id, device.name]));
  const ids = knownDevices
    .filter(
      (device) =>
        device.id === selectedDeviceId ||
        isSidebarDeviceVisible(visibility, runtimeNodeId, device.id)
    )
    .map((device) => device.id);
  const seen = new Set(ids);
  for (const id of sidebarVisibleDeviceIdsForNode(visibility, runtimeNodeId)) {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (selectedDeviceId !== null && !seen.has(selectedDeviceId)) ids.push(selectedDeviceId);
  return ids.map((id) => ({ id, name: names.get(id) ?? id }));
}

function badgeOf(node: SidebarNodeEntry): NodeBadgeInfo {
  return {
    nodeId: node.runtimeNodeId,
    name: node.name,
    online: node.online,
    isSelf: node.isSelf,
  };
}

/**
 * 分节头兼作整节的拖拽手柄：鼠标要移动 8px 才激活（`useDeviceTreeSensors`），
 * 触摸要长按 250ms，所以头里的按钮照常点得动；`touch-pan-y` 让竖向滑动仍归页面滚动。
 */
function SectionHeader({
  node,
  hint,
  drag,
  disclosure,
}: {
  node: SidebarNodeEntry;
  hint?: string;
  drag?: SidebarNodeSortable;
  /** 传了就把节点名做成折叠开关（远端在线分节）；不传即今天的静态分节头。 */
  disclosure?: { expanded: boolean; onToggle: () => void };
}) {
  const badge = <NodeBadge info={badgeOf(node)} variant="plain" className="min-w-0 flex-1" />;
  return (
    <div
      ref={drag?.sortable.setDragHandleRef}
      {...drag?.sortable.dragHandleProps}
      aria-label={drag?.dragHandleLabel}
      className={cn(
        'flex items-center gap-2 px-1 py-0.5',
        drag && 'cursor-grab touch-pan-y select-none'
      )}
      data-testid={`sidebar-node-header-${node.runtimeNodeId}`}
    >
      {disclosure ? (
        <button
          type="button"
          onClick={disclosure.onToggle}
          aria-expanded={disclosure.expanded}
          data-testid={`sidebar-node-toggle-${node.runtimeNodeId}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left hover:bg-sidebar-accent"
        >
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none',
              disclosure.expanded && 'rotate-90'
            )}
          />
          {badge}
        </button>
      ) : (
        badge
      )}
      {hint && (
        <span className="shrink-0 truncate text-[10px] text-muted-foreground/70">{hint}</span>
      )}
    </div>
  );
}

/**
 * 在线但还没有该 node 会话：默认折叠，一个请求都不发。用户点开才触发静默登录
 * （`useNodeLoginGate` 用内存里的会话钥），登录期间显示转圈，失败退回「登录此节点」按钮
 * ——会话钥已经没了的话那个按钮会带 `?node=` 去登录页。
 *
 * 一台设备都没开侧边栏显示的 node 整节不出现：登录进去也只剩一个空标题，那条登录入口反而
 * 像是「登完就消失」。开启过设备的 node 才留这条紧凑行，供用户重新登录回来；正在浏览该 node
 * 某台设备时同样保留，否则页面上就没有登录入口可点了。
 */
function SidebarNodeSignIn({ node, drag }: { node: SidebarNodeEntry; drag?: SidebarNodeSortable }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const gate = useNodeLoginGate(node.runtimeNodeId, { enabled: expanded });
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
      data-testid={`sidebar-node-login-${node.runtimeNodeId}`}
      className={cn('space-y-0.5', presence.className, drag?.sortable.isDragging && 'opacity-60')}
    >
      <SectionHeader node={node} drag={drag} />
      <div className="px-1 pb-0.5">
        {!expanded ? (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors duration-(--tmex-motion-fast) ease-out hover:bg-sidebar-accent hover:text-foreground motion-reduce:transition-none"
            data-testid={`sidebar-node-expand-${node.runtimeNodeId}`}
            onClick={() => setExpanded(true)}
          >
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t('auth.node.loginToThisNode')}</span>
          </button>
        ) : gate.status === 'pending' ? (
          <div
            className="tmex-fade flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground"
            data-testid={`sidebar-node-pending-${node.runtimeNodeId}`}
          >
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
            <span className="truncate">{t('auth.node.loggingIn')}</span>
          </div>
        ) : (
          <div className="tmex-fade flex flex-col gap-1">
            {gate.code ? (
              <span
                className="px-1 text-[10px] text-destructive"
                data-testid={`sidebar-node-error-${node.runtimeNodeId}`}
              >
                {t(loginErrorKey(gate.code, 'password'))}
              </span>
            ) : null}
            <NodeLoginButton nodeId={node.runtimeNodeId} nodeName={node.name} className="w-full" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 离线分节：灰显最近一次已知的设备（本地快照优先，其次 node inventory），名字取不到就用
 * device id。一台可见设备都不剩时整节隐藏——过 `useSectionPresence` 淡出后再卸载，
 * 退场期间沿用锁住的设备列表，不会先掉内容再消失。
 */
function SidebarNodeOffline({
  node,
  drag,
}: { node: SidebarNodeEntry; drag?: SidebarNodeSortable }) {
  const { t } = useTranslation();
  // UI store 是宿主级共享实例（所有 node 同一份），离线分节没有自己的 runtime 也读得到。
  const visibility = useUIStore((state) => state.sidebarDeviceVisibility);
  const selectedDeviceId = selectedDeviceIdForNode(useLocation().pathname, node.runtimeNodeId);

  // 快照读 localStorage 并解析 JSON，按 node 与 inventory 记一次即可（离线期间不会变）。
  const knownDevices = useMemo(() => {
    const snapshot = offlineDevices(node.runtimeNodeId, node.inventory);
    return snapshot.length > 0
      ? snapshot.map((device) => ({ id: device.id, name: device.name }))
      : inventoryDevices(node.inventory);
  }, [node.runtimeNodeId, node.inventory]);
  const devices = offlineSidebarDevices(
    visibility,
    node.runtimeNodeId,
    knownDevices,
    selectedDeviceId
  );
  // 一台可见设备都没有时整节隐藏（与在线分节同一条规则）；self 例外，留空态。
  const hidden = shouldHideSidebarNodeSection(
    { total: knownDevices.length, visible: devices.length },
    node.isSelf
  );
  const presence = useSectionPresence(!hidden, devices);
  if (!presence.rendered) return null;

  return (
    <div
      ref={drag?.sortable.setNodeRef}
      style={drag?.sortable.style}
      data-testid={`sidebar-node-offline-${node.runtimeNodeId}`}
      className={cn('space-y-0.5', presence.className, drag?.sortable.isDragging && 'opacity-60')}
    >
      <SectionHeader node={node} hint={t('sidebar.node.offline')} drag={drag} />
      {presence.value.length === 0 ? (
        <div className="px-2 py-1 text-[11px] text-muted-foreground/60">
          {t('sidebar.node.noKnownDevices')}
        </div>
      ) : (
        presence.value.map((device) => (
          <Link
            key={device.id}
            to={nodeAppPath(node.runtimeNodeId, `/devices/${encodeURIComponent(device.id)}`)}
            data-testid={`sidebar-node-offline-device-${device.id}`}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground/60"
          >
            <Monitor className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{device.name}</span>
          </Link>
        ))
      )}
    </div>
  );
}

/**
 * 在线且已登录的分节：挂该 node 的运行时并渲染真实设备树。
 *
 * 分节头交给设备树一起渲染：可见设备数只有挂上该 node 运行时才读得到，
 * 一台都不显示时整节（含分节头）都不该出现。
 */
function SidebarNodeRuntimeSection({
  node,
  drag,
  disclosure,
}: {
  node: SidebarNodeEntry;
  drag?: SidebarNodeSortable;
  disclosure?: { expanded: boolean; onToggle: () => void };
}) {
  const { t } = useTranslation();
  return (
    <NodeRuntimeScope nodeId={node.runtimeNodeId}>
      <SideBarDeviceListForRuntime
        section={{
          testId: `sidebar-node-${node.runtimeNodeId}`,
          header: <SectionHeader node={node} drag={drag} disclosure={disclosure} />,
          keepWhenNoDevices: node.isSelf,
          containerRef: drag?.sortable.setNodeRef,
          containerStyle: drag?.sortable.style,
          containerClassName: drag?.sortable.isDragging ? 'opacity-60' : undefined,
        }}
        expansionKeyFor={
          node.runtimeNodeId === SELF_NODE_ID
            ? undefined
            : (deviceId) => `${node.runtimeNodeId}:${deviceId}`
        }
        emptyLabel={t('sidebar.node.noDevices')}
      />
    </NodeRuntimeScope>
  );
}

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
}: { node: SidebarNodeEntry; drag?: SidebarNodeSortable; onToggle: () => void }) {
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
  const disclosure = { expanded, onToggle: () => setExpanded(!expanded) };

  if (!expanded) {
    return <SidebarNodeCollapsed node={node} drag={drag} onToggle={() => setExpanded(true)} />;
  }
  return <SidebarNodeRuntimeSection node={node} drag={drag} disclosure={disclosure} />;
}

export function SidebarNodeSection({
  node,
  drag,
}: { node: SidebarNodeEntry; drag?: SidebarNodeSortable }) {
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
