// 顶栏「新建分组」「恢复默认布局」按钮的命令注册表。
//
// 与 `add-device-targets` 同一个理由：顶栏（PageActions）与页面主体（DevicesPage）挂在
// 两棵互不相连的子树里，没法用 context 把树的 ref / 数据层递上去。页面主体挂载时登记一组
// 回调，顶栏用 useSyncExternalStore 订阅；没人登记（页面没挂载）时顶栏不显示这些按钮。

import { useSyncExternalStore } from 'react';

export interface DevicesPageCommands {
  newFolder: () => void;
  resetLayout: () => void;
  /** 任一布局变更在飞：顶栏的恢复默认布局按钮禁用 */
  layoutBusy: boolean;
}

let current: DevicesPageCommands | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

/** 登记页面主体的命令，返回注销函数。 */
export function registerDevicesPageCommands(commands: DevicesPageCommands): () => void {
  current = commands;
  publish();
  return () => {
    if (current !== commands) return;
    current = null;
    publish();
  };
}

export function getDevicesPageCommands(): DevicesPageCommands | null {
  return current;
}

export function subscribeDevicesPageCommands(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function resetDevicesPageCommandsForTest(): void {
  current = null;
  listeners.clear();
}

export function useDevicesPageCommands(): DevicesPageCommands | null {
  return useSyncExternalStore(
    subscribeDevicesPageCommands,
    getDevicesPageCommands,
    getDevicesPageCommands
  );
}
