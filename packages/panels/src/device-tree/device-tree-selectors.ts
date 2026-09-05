// 设备树的按设备切片选择器：每行只订阅自己那台设备的快照与连接态，
// 避免整棵树跟着 snapshots 这张大表在每次 metadata patch 上重渲染。
// 返回值要么是原始值，要么是 store 里原样透出的引用，故无需额外的相等性比较。

import type { Device, LocaleCode, StateSnapshotPayload, TmuxWindow } from '@tmex/shared';
import { toBCP47 } from '@tmex/shared';
import { isSidebarDeviceVisible } from '@tmex/stores';
import { useTmuxStore } from '@tmex/stores/react';
import { useCallback } from 'react';

export interface DeviceSnapshotSlice {
  snapshots: Record<string, StateSnapshotPayload | undefined>;
}

export interface DeviceConnectivitySlice {
  deviceConnected: Record<string, boolean | undefined>;
  deviceErrors: Record<string, unknown>;
  deviceReconnecting: Record<string, unknown>;
}

function ownValue<T>(map: Record<string, T | undefined>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** 单台设备的窗口列表；引用只随该设备的快照变化，别的设备打补丁不会动它 */
export function selectDeviceWindows(
  state: DeviceSnapshotSlice,
  deviceId: string
): TmuxWindow[] | null {
  return ownValue(state.snapshots, deviceId)?.session?.windows ?? null;
}

/** 宿主未接管连接时的在线判定：已连接、无错误、且不在重连中 */
export function selectDeviceOnline(state: DeviceConnectivitySlice, deviceId: string): boolean {
  return (
    ownValue(state.deviceConnected, deviceId) === true &&
    !ownValue(state.deviceErrors, deviceId) &&
    !ownValue(state.deviceReconnecting, deviceId)
  );
}

export function useDeviceWindows(deviceId: string): TmuxWindow[] | null {
  return useTmuxStore(
    useCallback((state: DeviceSnapshotSlice) => selectDeviceWindows(state, deviceId), [deviceId])
  );
}

export function useDeviceOnline(deviceId: string): boolean {
  return useTmuxStore(
    useCallback((state: DeviceConnectivitySlice) => selectDeviceOnline(state, deviceId), [deviceId])
  );
}

/**
 * 侧边栏该展示哪些设备：远端 node 的设备默认隐藏，由「管理设备」逐台开启（可见性规则见
 * `@tmex/stores` 的 `isSidebarDeviceVisible`）。
 *
 * 当前路由选中的那台**无条件保留**：从「管理设备」点进一台未开启显示的远端设备后，
 * 侧边栏若把它一并滤掉，用户既看不到它、也没有窗口 / pane 树可点。
 */
export function selectSidebarVisibleDevices<T extends { id: string }>(
  devices: T[],
  visibility: Record<string, boolean>,
  runtimeNodeId: string,
  selectedDeviceId?: string
): T[] {
  return devices.filter(
    (device) =>
      device.id === selectedDeviceId || isSidebarDeviceVisible(visibility, runtimeNodeId, device.id)
  );
}

export interface SidebarDeviceStats {
  /** 该 node 下的设备总数（含未勾选显示的） */
  total: number;
  /** 侧边栏实际会渲染的设备数 */
  visible: number;
  /** `/api/devices` 还没落地（含只有占位数据）：此刻的 0 台不代表真的没有设备 */
  pending?: boolean;
}

/**
 * 聚合侧边栏里某个 node 的分节是否整体隐藏（连分节头一起）。
 *
 * 一台可显示的设备都没有时隐藏：全部未勾选显示的 node 只剩一个空标题，纯属噪声。
 * `keepWhenNoDevices` 是例外——本机分节即使一台设备都没有也要留着空态引导用户去添加。
 *
 * `pending` 期间一律不隐藏：设备列表要跨节点走一趟直连 / 中转，弱网下能等好几秒，
 * 按那时的「零设备」把整节（含节点名与在线徽标）藏起来，正是「重开 PWA 后节点半天不出现」
 * 的直接成因。
 */
export function shouldHideSidebarNodeSection(
  stats: SidebarDeviceStats,
  keepWhenNoDevices: boolean
): boolean {
  if (stats.pending === true) return false;
  if (stats.visible > 0) return false;
  return stats.total > 0 || !keepWhenNoDevices;
}

/**
 * 把「只含可见设备」的拖拽结果合并回完整设备顺序。
 *
 * 侧边栏可能隐藏了一部分设备（远端 node 默认不显示），但重排接口按提交序列整体重写
 * `sortOrder = index`：只提交可见 id 会让隐藏设备留着旧序号与新序号撞车，重新开启显示时
 * 位置随机。做法是保持隐藏设备在完整顺序里的原槽位不动，把重排后的可见 id 依次填回可见槽位。
 *
 * @param allSortedIds 完整设备列表按当前顺序排好的 id
 * @param visibleIdsBefore 拖拽前的可见 id（顺序与 allSortedIds 中的可见槽位一致）
 * @param visibleIdsAfter 拖拽后的可见 id 顺序
 */
export function mergeReorderedVisibleIds(
  allSortedIds: readonly string[],
  visibleIdsBefore: readonly string[],
  visibleIdsAfter: readonly string[]
): string[] {
  const visible = new Set(visibleIdsBefore);
  const reordered = visibleIdsAfter.filter((id) => visible.has(id));
  const merged: string[] = [];
  let cursor = 0;
  for (const id of allSortedIds) {
    if (!visible.has(id)) {
      merged.push(id);
      continue;
    }
    const next = reordered[cursor];
    cursor += 1;
    if (next !== undefined) {
      merged.push(next);
    }
  }
  // 设备列表刚变动时 allSortedIds 可能还没收录某个可见 id；补在末尾，别把设备漏出提交序列
  const placed = new Set(merged);
  for (const id of reordered) {
    if (!placed.has(id)) {
      merged.push(id);
      placed.add(id);
    }
  }
  return merged;
}

// 设备列表的统一顺序：先 sortOrder 再按名称做 locale 感知比较；顺带按 id 去重（缓存 / 快照 / 节点 inventory 会撞 id）
export function sortDevices<T extends Device>(devices: readonly T[], language: LocaleCode): T[] {
  const byId = new Map<string, T>();
  for (const device of devices) if (!byId.has(device.id)) byId.set(device.id, device);
  return [...byId.values()].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder ||
      a.name.localeCompare(b.name, toBCP47(language), { numeric: true, sensitivity: 'base' })
  );
}
