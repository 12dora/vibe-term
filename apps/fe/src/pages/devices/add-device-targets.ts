// 设备页右上角唯一那个「+」的目标注册表。
//
// 顶栏（PageActions）与页面主体（DevicesPage）由 PageWrapper 挂在两棵**互不相连**的子树里，
// 没法用 React context 把面板 ref 传上去；这里用一个模块级注册表：每个 ready 的 node 分组
// 挂载时登记自己的 `openAddDevice`，顶栏按 useSyncExternalStore 订阅当前可添加的节点。
// 空注册表 = standalone / 单面板形态，顶栏退回派发全局事件（旧行为不变）。

import type { AddDevicePreset } from '@tmex/panels/device-management';
import { useSyncExternalStore } from 'react';

export interface AddDeviceTarget {
  /** 路由 / 运行时 id：entry 自身为 `self`。 */
  runtimeNodeId: string;
  name: string;
  isSelf: boolean;
  /** 打开该 node 面板的新建设备对话框；`preset` 预选设备类型。 */
  open: (preset?: AddDevicePreset) => void;
}

/** self 排最前，其余按名称排序，与设备页分组顺序一致。 */
export function sortAddDeviceTargets(targets: AddDeviceTarget[]): AddDeviceTarget[] {
  return [...targets].sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

const registry = new Map<string, AddDeviceTarget>();
const listeners = new Set<() => void>();
// useSyncExternalStore 要求快照引用稳定，只在注册表变动时重建。
let snapshot: AddDeviceTarget[] = [];

function publish(): void {
  snapshot = sortAddDeviceTargets([...registry.values()]);
  for (const listener of listeners) listener();
}

/** 登记一个可添加设备的 node，返回注销函数（分组卸载 / 变为非 ready 时调用）。 */
export function registerAddDeviceTarget(target: AddDeviceTarget): () => void {
  registry.set(target.runtimeNodeId, target);
  publish();
  return () => {
    if (registry.get(target.runtimeNodeId) !== target) return;
    registry.delete(target.runtimeNodeId);
    publish();
  };
}

export function getAddDeviceTargets(): AddDeviceTarget[] {
  return snapshot;
}

export function subscribeAddDeviceTargets(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

export function resetAddDeviceTargetsForTest(): void {
  registry.clear();
  listeners.clear();
  snapshot = [];
}

export function useAddDeviceTargets(): AddDeviceTarget[] {
  return useSyncExternalStore(subscribeAddDeviceTargets, getAddDeviceTargets, getAddDeviceTargets);
}
