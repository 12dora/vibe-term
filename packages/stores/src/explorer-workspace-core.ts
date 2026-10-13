// 文件管理器工作区的基础层：类型、常量、路径 / 分栏比例工具与只读选择器（纯函数，不依赖 zustand）。

/** 不带 node 前缀的应用路由（文件管理器恒挂在入口 node 的外壳下） */
export const EXPLORER_ROUTE = '/explorer';
export const EXPLORER_MAX_PANES = 3;
export const EXPLORER_HISTORY_LIMIT = 50;
/** 单个分栏的最小宽度占比 */
export const EXPLORER_MIN_PANE_FRACTION = 0.15;

/** nodeId 为运行时 node id（'self' | 32 位 hex）；path 为归一化绝对路径，除 '/' 外不带尾斜杠 */
export interface ExplorerLocation {
  nodeId: string;
  rootId: string;
  path: string;
}

/** 当前路径 = history[index] */
export interface ExplorerTab {
  id: string;
  nodeId: string;
  rootId: string;
  history: string[];
  index: number;
}

export interface ExplorerPane {
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

export type ExplorerViewMode = 'list' | 'grid';
export type ExplorerSortKey = 'name' | 'size' | 'modifiedAt' | 'kind';

export interface ExplorerSort {
  key: ExplorerSortKey;
  dir: 'asc' | 'desc';
}

export interface ExplorerClipboard {
  mode: 'copy' | 'cut';
  nodeId: string;
  rootId: string;
  deviceId: string;
  paths: string[];
}

export interface ExplorerWorkspaceData {
  tabs: Record<string, ExplorerTab>;
  /** 至少一个分栏（可以没有标签页） */
  panes: ExplorerPane[];
  activePaneId: string;
  /** 与 panes 等长的占比，和为 1，每项不小于 EXPLORER_MIN_PANE_FRACTION */
  paneSizes: number[];
  viewMode: ExplorerViewMode;
  showHidden: boolean;
  sort: ExplorerSort;
  clipboard: ExplorerClipboard | null;
}

export const EXPLORER_DEFAULT_SORT: ExplorerSort = { key: 'name', dir: 'asc' };

let idSeq = 0;

/** 测试环境可能没有 crypto.randomUUID，退回模块内计数器 */
export function createExplorerId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') {
    return randomUUID.call(globalThis.crypto);
  }
  idSeq += 1;
  return `explorer-${Date.now().toString(36)}-${idSeq}`;
}

/** 解析 `.` / `..`、合并重复斜杠、去掉尾斜杠；结果恒以 '/' 开头 */
export function normalizeExplorerPath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

/** `path` 是否等于 `ancestor` 或位于其下（两者须已归一化） */
export function isPathWithin(path: string, ancestor: string): boolean {
  if (path === ancestor) return true;
  if (ancestor === '/') return path.startsWith('/');
  return path.startsWith(`${ancestor}/`);
}

/** 上一级目录；已在根上（或不在根内）返回 null */
export function explorerParentPath(path: string, rootPath: string): string | null {
  const current = normalizeExplorerPath(path);
  const root = normalizeExplorerPath(rootPath);
  if (current === root || !isPathWithin(current, root)) return null;
  const parent = current.slice(0, current.lastIndexOf('/'));
  return parent === '' ? '/' : parent;
}

export function explorerTabPath(tab: ExplorerTab): string {
  return tab.history[tab.index] ?? tab.history[tab.history.length - 1] ?? '/';
}

export function explorerCanGoBack(tab: ExplorerTab): boolean {
  return tab.index > 0;
}

export function explorerCanGoForward(tab: ExplorerTab): boolean {
  return tab.index < tab.history.length - 1;
}

export function isExplorerRootOpen(
  data: Pick<ExplorerWorkspaceData, 'tabs'>,
  nodeId: string,
  rootId: string
): boolean {
  return Object.values(data.tabs).some((tab) => tab.nodeId === nodeId && tab.rootId === rootId);
}

/** 按分栏顺序、栏内标签顺序找当前位置等于 `loc` 的标签页 */
export function findExplorerTabByLocation(
  data: Pick<ExplorerWorkspaceData, 'tabs' | 'panes'>,
  loc: ExplorerLocation
): ExplorerTab | null {
  const path = normalizeExplorerPath(loc.path);
  for (const pane of data.panes) {
    for (const tabId of pane.tabIds) {
      const tab = data.tabs[tabId];
      if (!tab || tab.nodeId !== loc.nodeId || tab.rootId !== loc.rootId) continue;
      if (explorerTabPath(tab) === path) return tab;
    }
  }
  return null;
}

/** 活动分栏里的活动标签页 */
export function explorerActiveTab(
  data: Pick<ExplorerWorkspaceData, 'tabs' | 'panes' | 'activePaneId'>
): ExplorerTab | null {
  const pane = data.panes.find((item) => item.id === data.activePaneId);
  return (pane?.activeTabId ? data.tabs[pane.activeTabId] : null) ?? null;
}

function equalPaneSizes(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}

/** 把低于下限的项钉在下限上，其余按原比例瓜分剩余空间；一轮可能压出新的越界项，故迭代到稳定 */
function clampPaneFractions(values: number[]): number[] {
  const count = values.length;
  const pinned = new Set<number>();
  for (let pass = 0; pass <= count; pass += 1) {
    const free = 1 - pinned.size * EXPLORER_MIN_PANE_FRACTION;
    const freeTotal = values.reduce((sum, value, i) => (pinned.has(i) ? sum : sum + value), 0);
    const share = (value: number) => (freeTotal > 0 ? (value / freeTotal) * free : 0);
    const before = pinned.size;
    values.forEach((value, i) => {
      if (!pinned.has(i) && share(value) < EXPLORER_MIN_PANE_FRACTION) pinned.add(i);
    });
    if (pinned.size === count) break;
    if (pinned.size === before) {
      return values.map((value, i) => (pinned.has(i) ? EXPLORER_MIN_PANE_FRACTION : share(value)));
    }
  }
  return equalPaneSizes(count);
}

/** 归一化分栏占比：长度不符 / 含非法值时均分，否则缩放到和为 1 并保证下限 */
export function normalizeExplorerPaneSizes(sizes: unknown, count: number): number[] {
  if (count <= 0) return [];
  if (!Array.isArray(sizes) || sizes.length !== count) return equalPaneSizes(count);
  if (count * EXPLORER_MIN_PANE_FRACTION > 1) return equalPaneSizes(count);
  const values: number[] = [];
  for (const size of sizes) {
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
      return equalPaneSizes(count);
    }
    values.push(size);
  }
  if (values.every((value) => value === 0)) return equalPaneSizes(count);
  return clampPaneFractions(values);
}

export function createInitialExplorerData(
  paneId: string = createExplorerId()
): ExplorerWorkspaceData {
  return {
    tabs: {},
    panes: [{ id: paneId, tabIds: [], activeTabId: null }],
    activePaneId: paneId,
    paneSizes: [1],
    viewMode: 'list',
    showHidden: false,
    sort: EXPLORER_DEFAULT_SORT,
    clipboard: null,
  };
}
