// 落盘的工作区可能被手工改坏或来自旧版本：逐字段校验，修不了的部分丢弃，保证不变量成立。

import {
  EXPLORER_DEFAULT_SORT,
  EXPLORER_HISTORY_LIMIT,
  EXPLORER_MAX_PANES,
  type ExplorerPane,
  type ExplorerSort,
  type ExplorerSortKey,
  type ExplorerTab,
  type ExplorerViewMode,
  type ExplorerWorkspaceData,
  createExplorerId,
  explorerTabOf,
  normalizeExplorerPaneSizes,
  normalizeExplorerPath,
} from './explorer-workspace-core';

const SORT_KEYS: readonly ExplorerSortKey[] = ['name', 'size', 'modifiedAt', 'kind'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function sanitizeHistory(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const history: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.startsWith('/')) return null;
    history.push(normalizeExplorerPath(entry));
  }
  return history;
}

function sanitizeIndex(value: unknown, length: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return length - 1;
  return Math.min(Math.max(value, 0), length - 1);
}

function sanitizeTab(id: string, value: unknown): ExplorerTab | null {
  if (!isRecord(value) || !isNonEmptyString(value.nodeId) || !isNonEmptyString(value.rootId)) {
    return null;
  }
  const history = sanitizeHistory(value.history);
  if (!history) return null;
  const index = sanitizeIndex(value.index, history.length);
  // 超长历史只保留包含当前位置的一个窗口
  const start = Math.max(0, Math.min(index, history.length - EXPLORER_HISTORY_LIMIT));
  return {
    id,
    nodeId: value.nodeId,
    rootId: value.rootId,
    history: history.slice(start, start + EXPLORER_HISTORY_LIMIT),
    index: index - start,
  };
}

/** `__proto__` 作键时对象展开 / 赋值的语义都不同于普通键，这种 id 只可能来自被改坏的数据，直接拒收 */
function isValidTabId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id !== '__proto__';
}

type TabEntry = [id: string, tab: ExplorerTab];

function sanitizeTabs(value: unknown): Record<string, ExplorerTab> {
  const entries: TabEntry[] = [];
  for (const [id, raw] of isRecord(value) ? Object.entries(value) : []) {
    const tab = isValidTabId(id) ? sanitizeTab(id, raw) : null;
    if (tab) entries.push([id, tab]);
  }
  return Object.fromEntries(entries);
}

/** 只保留存在（自有属性，见 explorerTabOf）且尚未被别的分栏认领的标签 id */
function claimTabIds(
  value: unknown,
  tabs: Record<string, ExplorerTab>,
  claimed: Set<string>
): string[] {
  const tabIds: string[] = [];
  for (const id of Array.isArray(value) ? value : []) {
    if (!isValidTabId(id) || !explorerTabOf(tabs, id) || claimed.has(id)) continue;
    claimed.add(id);
    tabIds.push(id);
  }
  return tabIds;
}

function readPanes(value: unknown, tabs: Record<string, ExplorerTab>): ExplorerPane[] {
  const panes: ExplorerPane[] = [];
  const claimed = new Set<string>();
  const paneIds = new Set<string>();
  for (const raw of Array.isArray(value) ? value : []) {
    if (!isRecord(raw) || !isNonEmptyString(raw.id) || paneIds.has(raw.id)) continue;
    paneIds.add(raw.id);
    const tabIds = claimTabIds(raw.tabIds, tabs, claimed);
    const active = typeof raw.activeTabId === 'string' ? raw.activeTabId : null;
    panes.push({
      id: raw.id,
      tabIds,
      activeTabId: active && tabIds.includes(active) ? active : (tabIds[0] ?? null),
    });
  }
  return panes;
}

/** 超出上限的分栏并入最后一个保留的分栏，标签页不丢 */
function clampPaneCount(panes: ExplorerPane[]): ExplorerPane[] {
  if (panes.length <= EXPLORER_MAX_PANES) return panes;
  const kept = panes.slice(0, EXPLORER_MAX_PANES);
  const last = kept[kept.length - 1];
  const overflow = panes.slice(EXPLORER_MAX_PANES).flatMap((pane) => pane.tabIds);
  const tabIds = [...last.tabIds, ...overflow];
  kept[kept.length - 1] = { ...last, tabIds, activeTabId: last.activeTabId ?? tabIds[0] ?? null };
  return kept;
}

function sanitizePanes(value: unknown, tabs: Record<string, ExplorerTab>): ExplorerPane[] {
  const panes = clampPaneCount(readPanes(value, tabs).filter((pane) => pane.tabIds.length > 0));
  if (panes.length > 0) return panes;
  const first = Array.isArray(value) ? value.find(isRecord) : undefined;
  const id = first && isNonEmptyString(first.id) ? first.id : createExplorerId();
  return [{ id, tabIds: [], activeTabId: null }];
}

function sanitizeSort(value: unknown): ExplorerSort {
  if (!isRecord(value) || !SORT_KEYS.includes(value.key as ExplorerSortKey)) {
    return EXPLORER_DEFAULT_SORT;
  }
  return { key: value.key as ExplorerSortKey, dir: value.dir === 'desc' ? 'desc' : 'asc' };
}

function sanitizeViewMode(value: unknown): ExplorerViewMode {
  return value === 'grid' ? 'grid' : 'list';
}

/**
 * 修复 / 校验任意输入为合法工作区：历史损坏的标签页丢弃、悬空的标签 id 清掉、
 * 没挂在任何分栏上的标签页丢弃、至少一个分栏、分栏数不超上限、占比重新归一化。
 * 剪贴板从不落盘，恒为 null。
 */
export function sanitizeExplorerData(raw: unknown): ExplorerWorkspaceData {
  const source = isRecord(raw) ? raw : {};
  const allTabs = sanitizeTabs(source.tabs);
  const panes = sanitizePanes(source.panes, allTabs);

  // 只留下被某个分栏认领的标签页（claimTabIds 已保证这些 id 都是 allTabs 的自有键）
  const claimed = new Set(panes.flatMap((pane) => pane.tabIds));
  const tabs = Object.fromEntries(Object.entries(allTabs).filter(([id]) => claimed.has(id)));

  const rawPaneCount = Array.isArray(source.panes) ? source.panes.length : 0;
  const activePaneId = panes.some((pane) => pane.id === source.activePaneId)
    ? (source.activePaneId as string)
    : panes[0].id;

  return {
    tabs,
    panes,
    activePaneId,
    // 分栏有增删时原占比已对不上号，直接均分
    paneSizes: normalizeExplorerPaneSizes(
      rawPaneCount === panes.length ? source.paneSizes : null,
      panes.length
    ),
    viewMode: sanitizeViewMode(source.viewMode),
    showHidden: source.showHidden === true,
    sort: sanitizeSort(source.sort),
    clipboard: null,
  };
}
