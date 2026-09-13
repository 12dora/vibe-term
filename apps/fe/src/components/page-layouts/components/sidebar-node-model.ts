// 侧边栏「一个 node」分节的数据形状与纯函数：inventory / 可见性 / 离线设备列表。

import { nodeAppPath, parseNodeIdFromPath } from '@vibeterm/api-client';
import type { NodeBadgeInfo, SortableRow } from '@vibeterm/panels/device-tree';
import { isSidebarDeviceVisible } from '@vibeterm/stores';
import { matchPath } from 'react-router';

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

export interface SidebarNodeRuntimeSectionProps {
  node: SidebarNodeEntry;
  drag?: SidebarNodeSortable;
  disclosure?: { expanded: boolean; onToggle: () => void };
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

export function badgeOf(node: SidebarNodeEntry): NodeBadgeInfo {
  return {
    nodeId: node.runtimeNodeId,
    name: node.name,
    online: node.online,
    isSelf: node.isSelf,
  };
}

/**
 * mesh 列表每收到一次 NODE_EVENT 都会重建整份分节条目（`patchNodesWithEvent` 无条件换对象），
 * 默认的引用相等比较因此永远命中不了。分节渲染只读这几个字段，逐字段比即可挡住这类空转；
 * `inventory` 只在事件真的带了新的时才换引用，按引用比是安全的。
 */
export function sameNodeEntry(a: SidebarNodeEntry, b: SidebarNodeEntry): boolean {
  return (
    a.id === b.id &&
    a.runtimeNodeId === b.runtimeNodeId &&
    a.name === b.name &&
    a.online === b.online &&
    a.loggedIn === b.loggedIn &&
    a.isSelf === b.isSelf &&
    a.inventory === b.inventory
  );
}

export function sameRuntimeSectionProps(
  prev: SidebarNodeRuntimeSectionProps,
  next: SidebarNodeRuntimeSectionProps
): boolean {
  return (
    prev.drag === next.drag &&
    prev.disclosure === next.disclosure &&
    sameNodeEntry(prev.node, next.node)
  );
}
