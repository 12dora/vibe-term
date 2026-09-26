// 侧边栏设备可见性：所有 node 共用一份 UI store（见 node-connection-manager 的 uiStore()），
// 而 device id 只在单个 node 内唯一，因此按 `${runtimeNodeId}:${deviceId}` 复合键存储。
//
// 缺省规则：本机（`self`）的设备默认显示，远端 node 的设备默认隐藏——mesh 下挂几十台 node 时
// 侧边栏不应被别人的设备淹没；用户在「管理设备」里逐台开启。显式写入的值永远优先。

import { SELF_NODE_ID } from '@vibeterm/api-client';

export function sidebarDeviceVisibilityKey(runtimeNodeId: string, deviceId: string): string {
  return `${runtimeNodeId}:${deviceId}`;
}

export function isSidebarDeviceVisible(
  map: Record<string, boolean>,
  runtimeNodeId: string,
  deviceId: string
): boolean {
  const stored = map[sidebarDeviceVisibilityKey(runtimeNodeId, deviceId)];
  return stored ?? runtimeNodeId === SELF_NODE_ID;
}

/**
 * 侧边栏「文件」页的设备可见性，与终端页分开记（同一套复合键，另一张表）。
 *
 * 缺省规则与终端页对齐：本机（`self`）且配了目录的设备默认显示，远端 node 的设备一律默认隐藏
 * ——mesh 下挂几十台 node 时，别人配的目录会把文件树灌满，用户在「管理设备」里逐台开启；
 * 没配目录时无从显示，缺省即关。显式写入的值永远优先。
 */
export function isSidebarFilesVisible(
  map: Record<string, boolean>,
  runtimeNodeId: string,
  deviceId: string,
  hasRoots: boolean
): boolean {
  const stored = map[sidebarDeviceVisibilityKey(runtimeNodeId, deviceId)];
  return stored ?? (runtimeNodeId === SELF_NODE_ID && hasRoots);
}

/**
 * 文件侧栏里一个**没挂运行时**（折叠 / 离线 / 未登录）的 node 分节该不该出头。
 *
 * 拿不到该 node 的目录列表，只能按偏好表推断：远端设备缺省隐藏，用户没显式打开过任何一台时
 * 整节必然为空——出头的话一点开就消失。本机缺省可见，推断不出，交给宿主按目录列表判断。
 */
export function mayShowSidebarFilesNode(
  map: Record<string, boolean>,
  runtimeNodeId: string
): boolean {
  if (runtimeNodeId === SELF_NODE_ID) return true;
  const prefix = sidebarDeviceVisibilityKey(runtimeNodeId, '');
  return Object.entries(map).some(([key, visible]) => visible && key.startsWith(prefix));
}

/**
 * 清掉某 node 下「显式打开、但设备已没有目录（或设备已删除）」的文件开关。
 *
 * 这种键在设备卡片上显示为关且置灰，用户改不回去，却会让折叠分节一直出头
 * （见 `mayShowSidebarFilesNode`）。只能拿该 node 权威的目录列表来清：离线、未登录、
 * 加载失败时都不许调。删键而不是写 false：没目录时两者等价，缺省规则照旧生效。
 */
export function pruneStaleSidebarFilesVisibility(
  map: Record<string, boolean>,
  runtimeNodeId: string,
  deviceIdsWithRoots: ReadonlySet<string>
): Record<string, boolean> {
  const prefix = sidebarDeviceVisibilityKey(runtimeNodeId, '');
  let next: Record<string, boolean> | null = null;
  for (const [key, visible] of Object.entries(map)) {
    if (!visible || !key.startsWith(prefix)) continue;
    if (deviceIdsWithRoots.has(key.slice(prefix.length))) continue;
    next ??= { ...map };
    delete next[key];
  }
  return next ?? map;
}
