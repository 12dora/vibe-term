// 文件管理器工作区 store：只负责把纯状态迁移（explorer-workspace-model）接到 zustand + persist 上。
// 与 UI 偏好一样是宿主级状态：多 node 宿主里所有 runtime 共用同一个实例（见 node-connection-manager）。

import { type StoreApi, create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  type ExplorerWorkspaceActions,
  type ExplorerWorkspaceData,
  type ExplorerWorkspaceState,
  createExplorerId,
  createInitialExplorerData,
  explorerActiveTab,
  sanitizeExplorerData,
  explorerTransitions as transitions,
} from './explorer-workspace-model';
import type { RuntimeCore } from './runtime';
import { type WritableStorage, createDeferredPersistStorage } from './ui-persist';

const EXPLORER_PERSIST_VERSION = 1;

/** 落盘字段面；剪贴板只在内存里，从不落盘 */
type ExplorerPersistedState = Pick<
  ExplorerWorkspaceData,
  'tabs' | 'panes' | 'activePaneId' | 'paneSizes' | 'viewMode' | 'showHidden' | 'sort'
>;

export interface CreateExplorerStoreOptions {
  /** 测试注入用；缺省走 window.localStorage */
  storage?: WritableStorage;
  /** 由 createAppRuntime 传入，dispose 后不再落盘 */
  disposers?: Array<() => void>;
}

type SetState = StoreApi<ExplorerWorkspaceState>['setState'];
type GetState = StoreApi<ExplorerWorkspaceState>['getState'];

function partializeExplorerState(state: ExplorerWorkspaceState): ExplorerPersistedState {
  return {
    tabs: state.tabs,
    panes: state.panes,
    activePaneId: state.activePaneId,
    paneSizes: state.paneSizes,
    viewMode: state.viewMode,
    showHidden: state.showHidden,
    sort: state.sort,
  };
}

/** 落盘状态 → 内存状态：整体过一遍校验修复；没有落盘内容时保持初始状态 */
function mergePersistedExplorerState(
  persisted: unknown,
  current: ExplorerWorkspaceState
): ExplorerWorkspaceState {
  if (persisted === null || persisted === undefined) return current;
  return { ...current, ...sanitizeExplorerData(persisted), clipboard: current.clipboard };
}

type LayoutActions = Pick<
  ExplorerWorkspaceActions,
  | 'openLocation'
  | 'closeLocation'
  | 'closeTab'
  | 'closeOtherTabs'
  | 'duplicateTab'
  | 'activateTab'
  | 'setActivePane'
  | 'moveTab'
  | 'splitTab'
  | 'closePane'
  | 'setPaneSizes'
  | 'pruneTabs'
>;

function layoutActions(set: SetState, get: GetState): LayoutActions {
  return {
    openLocation: (loc, opts) => {
      const tabId = createExplorerId();
      const next = transitions.openLocation(get(), loc, { ...opts, tabId });
      set(next);
      // 激活了已有标签页时新 id 不会入表，此时它就是活动分栏的活动标签页
      return next.tabs[tabId] ? tabId : (explorerActiveTab(next)?.id ?? tabId);
    },
    closeLocation: (nodeId, rootId) => set((s) => transitions.closeLocation(s, nodeId, rootId)),
    closeTab: (tabId) => set((s) => transitions.closeTab(s, tabId)),
    closeOtherTabs: (tabId) => set((s) => transitions.closeOtherTabs(s, tabId)),
    duplicateTab: (tabId) => {
      const newTabId = createExplorerId();
      const next = transitions.duplicateTab(get(), tabId, newTabId);
      set(next);
      return next.tabs[newTabId] ? newTabId : tabId;
    },
    activateTab: (tabId) => set((s) => transitions.activateTab(s, tabId)),
    setActivePane: (paneId) => set((s) => transitions.setActivePane(s, paneId)),
    moveTab: (tabId, toPaneId, toIndex) =>
      set((s) => transitions.moveTab(s, tabId, toPaneId, toIndex)),
    splitTab: (tabId) => {
      const current = get();
      const paneId = createExplorerId();
      const next = transitions.splitTab(current, tabId, { paneId, tabId: createExplorerId() });
      if (next === current) return null;
      set(next);
      return paneId;
    },
    closePane: (paneId) => set((s) => transitions.closePane(s, paneId)),
    setPaneSizes: (sizes) => set((s) => transitions.setPaneSizes(s, sizes)),
    pruneTabs: (isValid) => set((s) => transitions.pruneTabs(s, isValid)),
  };
}

type BrowseActions = Omit<ExplorerWorkspaceActions, keyof LayoutActions>;

function browseActions(set: SetState): BrowseActions {
  return {
    navigate: (tabId, path) => set((s) => transitions.navigate(s, tabId, path)),
    goBack: (tabId) => set((s) => transitions.goBack(s, tabId)),
    goForward: (tabId) => set((s) => transitions.goForward(s, tabId)),
    goUp: (tabId, rootPath) => set((s) => transitions.goUp(s, tabId, rootPath)),
    switchRoot: (tabId, rootId, rootPath) =>
      set((s) => transitions.switchRoot(s, tabId, rootId, rootPath)),
    rebasePath: (nodeId, rootId, fromPath, toPath, rootPath) =>
      set((s) => transitions.rebasePath(s, { nodeId, rootId, rootPath }, fromPath, toPath)),
    setViewMode: (mode) => set((s) => transitions.setViewMode(s, mode)),
    setShowHidden: (show) => set((s) => transitions.setShowHidden(s, show)),
    setSort: (sort) => set((s) => transitions.setSort(s, sort)),
    setClipboard: (clipboard) => set((s) => transitions.setClipboard(s, clipboard)),
  };
}

export function createExplorerStore(
  core: Pick<RuntimeCore, 'storagePrefix'>,
  options: CreateExplorerStoreOptions = {}
) {
  // 不设延后字段：每次变更立即落盘，适配器只负责去重、容错与测试注入
  const persisted = createDeferredPersistStorage<ExplorerPersistedState>({
    deferredKeys: [],
    ...(options.storage ? { storage: options.storage } : {}),
  });

  const store = create<ExplorerWorkspaceState>()(
    persist(
      (set, get) => ({
        ...createInitialExplorerData(),
        ...layoutActions(set, get),
        ...browseActions(set),
      }),
      {
        name: `${core.storagePrefix}vibeterm-explorer`,
        storage: persisted.storage,
        version: EXPLORER_PERSIST_VERSION,
        // 版本不符也交给 merge 里的校验修复，不整份丢弃
        migrate: (state) => state as ExplorerPersistedState,
        partialize: partializeExplorerState,
        merge: mergePersistedExplorerState,
      }
    )
  );

  options.disposers?.push(() => persisted.dispose());
  return store;
}

export type ExplorerStore = ReturnType<typeof createExplorerStore>;
