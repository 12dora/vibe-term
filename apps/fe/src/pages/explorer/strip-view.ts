// 标签栏要列出哪些标签页：宽屏是本分栏的；窄屏只画一个分栏，标签栏就把所有分栏的标签页
// 按分栏顺序接在一起，否则别的分栏里的标签页无处可达。

import type { ExplorerPane } from '@vibeterm/stores';

export interface StripTabsView {
  tabIds: string[];
  /** 每个标签页所属的分栏（菜单里的「关闭其他」「关闭分栏」按所属分栏算） */
  ownerOf: ReadonlyMap<string, ExplorerPane>;
}

export function stripTabsView(
  panes: readonly ExplorerPane[],
  pane: ExplorerPane,
  merged: boolean
): StripTabsView {
  const sources = merged ? panes : [pane];
  const tabIds: string[] = [];
  const ownerOf = new Map<string, ExplorerPane>();
  for (const source of sources) {
    for (const tabId of source.tabIds) {
      if (ownerOf.has(tabId)) continue;
      ownerOf.set(tabId, source);
      tabIds.push(tabId);
    }
  }
  return { tabIds, ownerOf };
}

/** 方向键的落点：到头不循环 */
export function neighbourTabId(
  tabIds: readonly string[],
  tabId: string,
  delta: -1 | 1
): string | null {
  const index = tabIds.indexOf(tabId);
  if (index < 0) return null;
  return tabIds[index + delta] ?? null;
}
