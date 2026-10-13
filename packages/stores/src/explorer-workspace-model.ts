// 文件管理器工作区的纯状态机：每个动作都是 `(data, …args) => data`，不改入参；
// 无变化时原样返回入参引用（zustand 据此跳过通知）。新建标签页 / 分栏的 id 由调用方传入，保持可测。

import {
  EXPLORER_HISTORY_LIMIT,
  EXPLORER_MAX_PANES,
  type ExplorerClipboard,
  type ExplorerLocation,
  type ExplorerPane,
  type ExplorerSort,
  type ExplorerTab,
  type ExplorerViewMode,
  type ExplorerWorkspaceData,
  explorerParentPath,
  explorerTabPath,
  findExplorerTabByLocation,
  isPathWithin,
  normalizeExplorerPaneSizes,
  normalizeExplorerPath,
} from './explorer-workspace-core';

export * from './explorer-workspace-core';
export { sanitizeExplorerData } from './explorer-workspace-sanitize';

export interface ExplorerWorkspaceActions {
  /** 激活当前位置等于 `loc` 的已有标签页（任意分栏），否则在活动分栏（或 `paneId`）新开；`newTab` 恒新开。返回标签 id。 */
  openLocation(loc: ExplorerLocation, opts?: { newTab?: boolean; paneId?: string }): string;
  /** 关闭该 node + root 的全部标签页 */
  closeLocation(nodeId: string, rootId: string): void;
  /** 关闭后激活右邻，否则左邻；分栏被清空且还有别的分栏时一并移除 */
  closeTab(tabId: string): void;
  /** 只作用于它所在的分栏 */
  closeOtherTabs(tabId: string): void;
  /** 紧跟其后新开一个标签页，历史只含当前路径。返回新标签 id。 */
  duplicateTab(tabId: string): string;
  /** 同时把它所在的分栏设为活动分栏 */
  activateTab(tabId: string): void;
  setActivePane(paneId: string): void;
  /** 栏内重排或跨栏移动；`toIndex` 为标签取出后目标栏内的插入位置（越界收拢） */
  moveTab(tabId: string, toPaneId: string, toIndex: number): void;
  /** 在其分栏右侧新开分栏并放入该标签页的副本；已达上限时不动并返回 null。返回新分栏 id。 */
  splitTab(tabId: string): string | null;
  /** 连同标签页一起关闭；最后一个分栏只清空不移除 */
  closePane(paneId: string): void;
  setPaneSizes(sizes: number[]): void;
  /** 压栈并截断前进历史；与当前路径相同时不动 */
  navigate(tabId: string, path: string): void;
  goBack(tabId: string): void;
  goForward(tabId: string): void;
  /** 进入上一级（压栈），不越过 rootPath */
  goUp(tabId: string, rootPath: string): void;
  /** 同一 node 换根，历史重置为 [rootPath] */
  switchRoot(tabId: string, rootId: string, rootPath: string): void;
  /** 重命名 / 移动 / 删除之后改写该 node + root 下受影响的历史；`toPath: null` 即已删除，退回最近的存活祖先 */
  rebasePath(
    nodeId: string,
    rootId: string,
    fromPath: string,
    toPath: string | null,
    rootPath: string
  ): void;
  setViewMode(mode: ExplorerViewMode): void;
  setShowHidden(show: boolean): void;
  setSort(sort: ExplorerSort): void;
  setClipboard(clipboard: ExplorerClipboard | null): void;
  /** 丢弃 node / root 已不存在的标签页 */
  pruneTabs(isValid: (tab: ExplorerTab) => boolean): void;
}

export type ExplorerWorkspaceState = ExplorerWorkspaceData & ExplorerWorkspaceActions;

type Data = ExplorerWorkspaceData;

function paneIndexOfTab(data: Data, tabId: string): number {
  return data.panes.findIndex((pane) => pane.tabIds.includes(tabId));
}

function clampIndex(value: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.min(Math.max(Math.trunc(value), 0), max);
}

function insertAt<T>(list: readonly T[], index: number, item: T): T[] {
  return [...list.slice(0, index), item, ...list.slice(index)];
}

function replaceAt<T>(list: readonly T[], index: number, item: T): T[] {
  return list.map((current, i) => (i === index ? item : current));
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/** 活动标签被移除时的接班人：先右邻，再左邻 */
function nextActiveTabId(pane: ExplorerPane, removed: ReadonlySet<string>): string | null {
  if (pane.activeTabId && !removed.has(pane.activeTabId)) return pane.activeTabId;
  const at = pane.activeTabId ? pane.tabIds.indexOf(pane.activeTabId) : -1;
  const survives = (id: string) => !removed.has(id);
  const right = pane.tabIds.slice(at + 1).find(survives);
  if (right) return right;
  return pane.tabIds.slice(0, Math.max(at, 0)).reverse().find(survives) ?? null;
}

/** 被移除分栏的占比并给左邻（首栏并给右邻） */
function mergePaneSizeAt(sizes: readonly number[], index: number): number[] {
  const heir = index > 0 ? index - 1 : 1;
  const next = sizes.map((size, i) => (i === heir ? size + (sizes[index] ?? 0) : size));
  return next.filter((_, i) => i !== index);
}

/** 活动分栏已不存在时改指它原位置的左邻（没有则首栏） */
function fixActivePane(data: Data, previous: readonly ExplorerPane[]): Data {
  if (data.panes.some((pane) => pane.id === data.activePaneId)) return data;
  const was = previous.findIndex((pane) => pane.id === data.activePaneId);
  const index = Math.min(Math.max(was - 1, 0), data.panes.length - 1);
  return { ...data, activePaneId: data.panes[index].id };
}

/** 移除没有标签页的分栏，但始终留下至少一个 */
function dropEmptyPanes(data: Data): Data {
  let panes = data.panes;
  let paneSizes = data.paneSizes;
  for (let i = panes.length - 1; i >= 0 && panes.length > 1; i -= 1) {
    if (panes[i].tabIds.length > 0) continue;
    panes = panes.filter((_, j) => j !== i);
    paneSizes = mergePaneSizeAt(paneSizes, i);
  }
  if (panes === data.panes) return data;
  const next = { ...data, panes, paneSizes: normalizeExplorerPaneSizes(paneSizes, panes.length) };
  return fixActivePane(next, data.panes);
}

function removeTabs(data: Data, removed: ReadonlySet<string>): Data {
  if (removed.size === 0) return dropEmptyPanes(data);
  const tabs: Record<string, ExplorerTab> = {};
  for (const [id, tab] of Object.entries(data.tabs)) {
    if (!removed.has(id)) tabs[id] = tab;
  }
  const panes = data.panes.map((pane) => {
    if (!pane.tabIds.some((id) => removed.has(id))) return pane;
    return {
      ...pane,
      tabIds: pane.tabIds.filter((id) => !removed.has(id)),
      activeTabId: nextActiveTabId(pane, removed),
    };
  });
  return dropEmptyPanes({ ...data, tabs, panes });
}

function removeTabsWhere(data: Data, shouldRemove: (tab: ExplorerTab) => boolean): Data {
  const removed = new Set<string>();
  for (const tab of Object.values(data.tabs)) {
    if (shouldRemove(tab)) removed.add(tab.id);
  }
  return removed.size === 0 ? data : removeTabs(data, removed);
}

/** 把新标签页放进指定分栏并激活（分栏也随之成为活动分栏） */
function insertTab(data: Data, tab: ExplorerTab, paneIndex: number, at: number): Data {
  const pane = data.panes[paneIndex];
  const nextPane = { ...pane, tabIds: insertAt(pane.tabIds, at, tab.id), activeTabId: tab.id };
  return {
    ...data,
    tabs: { ...data.tabs, [tab.id]: tab },
    panes: replaceAt(data.panes, paneIndex, nextPane),
    activePaneId: pane.id,
  };
}

function withTab(data: Data, tabId: string, update: (tab: ExplorerTab) => ExplorerTab): Data {
  const tab = data.tabs[tabId];
  if (!tab) return data;
  const next = update(tab);
  return next === tab ? data : { ...data, tabs: { ...data.tabs, [tabId]: next } };
}

function freshTab(id: string, source: ExplorerTab): ExplorerTab {
  return {
    id,
    nodeId: source.nodeId,
    rootId: source.rootId,
    history: [explorerTabPath(source)],
    index: 0,
  };
}

function pushHistory(tab: ExplorerTab, path: string): ExplorerTab {
  if (path === explorerTabPath(tab)) return tab;
  const history = [...tab.history.slice(0, tab.index + 1), path].slice(-EXPLORER_HISTORY_LIMIT);
  return { ...tab, history, index: history.length - 1 };
}

export function activateTab(data: Data, tabId: string): Data {
  const paneIndex = paneIndexOfTab(data, tabId);
  if (paneIndex < 0) return data;
  const pane = data.panes[paneIndex];
  if (pane.activeTabId === tabId && data.activePaneId === pane.id) return data;
  const panes =
    pane.activeTabId === tabId
      ? data.panes
      : replaceAt(data.panes, paneIndex, { ...pane, activeTabId: tabId });
  return { ...data, panes, activePaneId: pane.id };
}

export function setActivePane(data: Data, paneId: string): Data {
  if (data.activePaneId === paneId || !data.panes.some((pane) => pane.id === paneId)) return data;
  return { ...data, activePaneId: paneId };
}

/** `tabId` 仅在需要新开标签页时使用；激活已有标签页时结果里不会出现它 */
export function openLocation(
  data: Data,
  loc: ExplorerLocation,
  opts: { tabId: string; newTab?: boolean; paneId?: string }
): Data {
  const target = { ...loc, path: normalizeExplorerPath(loc.path) };
  const existing = opts.newTab ? null : findExplorerTabByLocation(data, target);
  if (existing) return activateTab(data, existing.id);

  const wanted = data.panes.findIndex((pane) => pane.id === opts.paneId);
  const active = data.panes.findIndex((pane) => pane.id === data.activePaneId);
  const paneIndex = wanted >= 0 ? wanted : Math.max(active, 0);
  const tab: ExplorerTab = {
    id: opts.tabId,
    nodeId: target.nodeId,
    rootId: target.rootId,
    history: [target.path],
    index: 0,
  };
  return insertTab(data, tab, paneIndex, data.panes[paneIndex].tabIds.length);
}

export function closeLocation(data: Data, nodeId: string, rootId: string): Data {
  return removeTabsWhere(data, (tab) => tab.nodeId === nodeId && tab.rootId === rootId);
}

export function closeTab(data: Data, tabId: string): Data {
  return data.tabs[tabId] ? removeTabs(data, new Set([tabId])) : data;
}

export function closeOtherTabs(data: Data, tabId: string): Data {
  const pane = data.panes[paneIndexOfTab(data, tabId)];
  if (!pane || pane.tabIds.length === 1) return data;
  return removeTabs(data, new Set(pane.tabIds.filter((id) => id !== tabId)));
}

export function duplicateTab(data: Data, tabId: string, newTabId: string): Data {
  const source = data.tabs[tabId];
  const paneIndex = paneIndexOfTab(data, tabId);
  if (!source || paneIndex < 0) return data;
  const at = data.panes[paneIndex].tabIds.indexOf(tabId) + 1;
  return insertTab(data, freshTab(newTabId, source), paneIndex, at);
}

export function moveTab(data: Data, tabId: string, toPaneId: string, toIndex: number): Data {
  const from = paneIndexOfTab(data, tabId);
  const to = data.panes.findIndex((pane) => pane.id === toPaneId);
  if (from < 0 || to < 0) return data;

  const removed = new Set([tabId]);
  let unchanged = from === to && data.activePaneId === toPaneId;
  const panes = data.panes.map((pane, i) => {
    if (i !== from && i !== to) return pane;
    let { tabIds, activeTabId } = pane;
    if (i === from) {
      activeTabId = nextActiveTabId(pane, removed);
      tabIds = tabIds.filter((id) => id !== tabId);
    }
    if (i === to) {
      tabIds = insertAt(tabIds, clampIndex(toIndex, tabIds.length), tabId);
      unchanged = unchanged && pane.activeTabId === tabId && sameList(tabIds, pane.tabIds);
      activeTabId = tabId;
    }
    return { ...pane, tabIds, activeTabId };
  });
  return unchanged ? data : dropEmptyPanes({ ...data, panes, activePaneId: toPaneId });
}

/** 已达分栏上限或标签页不存在时原样返回（调用方据引用相等判断是否生效） */
export function splitTab(data: Data, tabId: string, ids: { paneId: string; tabId: string }): Data {
  const source = data.tabs[tabId];
  const paneIndex = paneIndexOfTab(data, tabId);
  if (!source || paneIndex < 0 || data.panes.length >= EXPLORER_MAX_PANES) return data;

  const pane: ExplorerPane = { id: ids.paneId, tabIds: [ids.tabId], activeTabId: ids.tabId };
  const panes = insertAt(data.panes, paneIndex + 1, pane);
  const half = (data.paneSizes[paneIndex] ?? 1 / data.panes.length) / 2;
  const sizes = insertAt(replaceAt(data.paneSizes, paneIndex, half), paneIndex + 1, half);
  return {
    ...data,
    tabs: { ...data.tabs, [ids.tabId]: freshTab(ids.tabId, source) },
    panes,
    activePaneId: ids.paneId,
    paneSizes: normalizeExplorerPaneSizes(sizes, panes.length),
  };
}

export function closePane(data: Data, paneId: string): Data {
  const pane = data.panes.find((item) => item.id === paneId);
  return pane ? removeTabs(data, new Set(pane.tabIds)) : data;
}

export function setPaneSizes(data: Data, sizes: number[]): Data {
  if (!Array.isArray(sizes) || sizes.length !== data.panes.length) return data;
  const paneSizes = normalizeExplorerPaneSizes(sizes, data.panes.length);
  const same = paneSizes.every((size, i) => size === data.paneSizes[i]);
  return same ? data : { ...data, paneSizes };
}

export function navigate(data: Data, tabId: string, path: string): Data {
  return withTab(data, tabId, (tab) => pushHistory(tab, normalizeExplorerPath(path)));
}

export function goBack(data: Data, tabId: string): Data {
  return withTab(data, tabId, (tab) => (tab.index > 0 ? { ...tab, index: tab.index - 1 } : tab));
}

export function goForward(data: Data, tabId: string): Data {
  return withTab(data, tabId, (tab) =>
    tab.index < tab.history.length - 1 ? { ...tab, index: tab.index + 1 } : tab
  );
}

export function goUp(data: Data, tabId: string, rootPath: string): Data {
  return withTab(data, tabId, (tab) => {
    const parent = explorerParentPath(explorerTabPath(tab), rootPath);
    return parent === null ? tab : pushHistory(tab, parent);
  });
}

export function switchRoot(data: Data, tabId: string, rootId: string, rootPath: string): Data {
  const path = normalizeExplorerPath(rootPath);
  return withTab(data, tabId, (tab) => {
    const same = tab.rootId === rootId && tab.history.length === 1 && tab.history[0] === path;
    return same ? tab : { ...tab, rootId, history: [path], index: 0 };
  });
}

interface RebaseRule {
  from: string;
  to: string | null;
  /** 当前位置被删时的落脚点 */
  fallback: string;
}

function rebaseEntry(path: string, isCurrent: boolean, rule: RebaseRule): string | null {
  if (!isPathWithin(path, rule.from)) return path;
  if (rule.to !== null) return normalizeExplorerPath(`${rule.to}/${path.slice(rule.from.length)}`);
  return isCurrent ? rule.fallback : null;
}

/** 改写 / 剔除受影响的历史项，并合并由此产生的相邻重复项 */
function rebaseTab(tab: ExplorerTab, rule: RebaseRule): ExplorerTab {
  if (!tab.history.some((path) => isPathWithin(path, rule.from))) return tab;
  const history: string[] = [];
  let index = 0;
  tab.history.forEach((path, i) => {
    const isCurrent = i === tab.index;
    const next = rebaseEntry(path, isCurrent, rule);
    if (next !== null && history[history.length - 1] !== next) history.push(next);
    if (isCurrent) index = history.length - 1;
  });
  return history.length > 0
    ? { ...tab, history, index }
    : { ...tab, history: [rule.fallback], index: 0 };
}

export function rebasePath(
  data: Data,
  target: { nodeId: string; rootId: string; rootPath: string },
  fromPath: string,
  toPath: string | null
): Data {
  const root = normalizeExplorerPath(target.rootPath);
  const from = normalizeExplorerPath(fromPath);
  const rule: RebaseRule = {
    from,
    to: toPath === null ? null : normalizeExplorerPath(toPath),
    fallback: explorerParentPath(from, root) ?? root,
  };
  if (rule.to === from) return data;

  let changed = false;
  const tabs: Record<string, ExplorerTab> = {};
  for (const [id, tab] of Object.entries(data.tabs)) {
    const affected = tab.nodeId === target.nodeId && tab.rootId === target.rootId;
    tabs[id] = affected ? rebaseTab(tab, rule) : tab;
    changed = changed || tabs[id] !== tab;
  }
  return changed ? { ...data, tabs } : data;
}

export function setViewMode(data: Data, viewMode: ExplorerViewMode): Data {
  return data.viewMode === viewMode ? data : { ...data, viewMode };
}

export function setShowHidden(data: Data, showHidden: boolean): Data {
  return data.showHidden === showHidden ? data : { ...data, showHidden };
}

export function setSort(data: Data, sort: ExplorerSort): Data {
  if (data.sort.key === sort.key && data.sort.dir === sort.dir) return data;
  return { ...data, sort: { key: sort.key, dir: sort.dir } };
}

export function setClipboard(data: Data, clipboard: ExplorerClipboard | null): Data {
  return data.clipboard === clipboard ? data : { ...data, clipboard };
}

export function pruneTabs(data: Data, isValid: (tab: ExplorerTab) => boolean): Data {
  return removeTabsWhere(data, (tab) => !isValid(tab));
}

/** 全部纯状态迁移；包主入口只导出这个对象，避免 `navigate` 之类的通用名字污染命名空间 */
export const explorerTransitions = {
  openLocation,
  closeLocation,
  closeTab,
  closeOtherTabs,
  duplicateTab,
  activateTab,
  setActivePane,
  moveTab,
  splitTab,
  closePane,
  setPaneSizes,
  navigate,
  goBack,
  goForward,
  goUp,
  switchRoot,
  rebasePath,
  setViewMode,
  setShowHidden,
  setSort,
  setClipboard,
  pruneTabs,
} as const;
