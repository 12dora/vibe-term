// 工作区 store 的句柄：宿主级单例，不挂在任何 node 运行时上。
// 动作引用在 store 生命周期内不变，取一次即可，不必订阅。

import type { ExplorerStore, ExplorerWorkspaceActions } from '@vibeterm/stores';
import { getExplorerStore } from '@vibeterm/stores/explorer';

export function useWorkspaceStore(): ExplorerStore {
  return getExplorerStore();
}

export function useWorkspaceActions(): ExplorerWorkspaceActions {
  return getExplorerStore().getState();
}
