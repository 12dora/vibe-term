// 工作区 store 的动作句柄：动作引用在 store 生命周期内不变，取一次即可，不必订阅。

import type { ExplorerStore, ExplorerWorkspaceActions } from '@vibeterm/stores';
import { useRuntime } from '@vibeterm/stores/react';

/** 所有 node 运行时共用同一个文件管理器 store，任意运行时子树下取到的都是它 */
export function useWorkspaceStore(): ExplorerStore {
  return useRuntime().stores.explorer;
}

export function useWorkspaceActions(): ExplorerWorkspaceActions {
  return useWorkspaceStore().getState();
}
