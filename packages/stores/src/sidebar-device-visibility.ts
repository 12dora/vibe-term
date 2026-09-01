// 侧边栏设备可见性：所有 node 共用一份 UI store（见 node-connection-manager 的 uiStore()），
// 而 device id 只在单个 node 内唯一，因此按 `${runtimeNodeId}:${deviceId}` 复合键存储。
//
// 缺省规则：本机（`self`）的设备默认显示，远端 node 的设备默认隐藏——hub 下挂几十台 node 时
// 侧边栏不应被别人的设备淹没；用户在「管理设备」里逐台开启。显式写入的值永远优先。

import { SELF_NODE_ID } from '@tmex/api-client';

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
 * ——hub 下挂几十台 node 时，别人配的目录会把文件树灌满，用户在「管理设备」里逐台开启；
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
