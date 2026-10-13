// 文件管理器工作区的值入口（`@vibeterm/stores/explorer`）。
// 不从包主入口导出：主入口被应用入口 chunk 静态引用，从那里导出会把整个模型带进首屏。

import { getExplorerStore } from './explorer-workspace';
import type { ExplorerWorkspaceState } from './explorer-workspace-model';

export {
  createExplorerStore,
  getExplorerStore,
  resetExplorerStoreForTest,
  type CreateExplorerStoreOptions,
  type ExplorerStore,
} from './explorer-workspace';
export {
  EXPLORER_DEFAULT_SORT,
  EXPLORER_HISTORY_LIMIT,
  EXPLORER_MAX_PANES,
  EXPLORER_MIN_PANE_FRACTION,
  EXPLORER_ROUTE,
  createExplorerId,
  createInitialExplorerData,
  explorerActiveTab,
  explorerCanGoBack,
  explorerCanGoForward,
  explorerParentPath,
  explorerTabOf,
  explorerTabPath,
  explorerTransitions,
  findExplorerTabByLocation,
  isExplorerRootOpen,
  isPathWithin,
  normalizeExplorerPaneSizes,
  normalizeExplorerPath,
  sanitizeExplorerData,
} from './explorer-workspace-model';

/** 宿主级单例，不经 runtime：没有 RuntimeProvider 也能用。 */
export function useExplorerStore<T>(selector: (state: ExplorerWorkspaceState) => T): T {
  return getExplorerStore()(selector);
}
