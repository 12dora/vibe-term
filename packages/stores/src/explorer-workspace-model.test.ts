import { describe, expect, test } from 'bun:test';
import {
  type ExplorerClipboard,
  type ExplorerWorkspaceData,
  activateTab,
  closeLocation,
  closeOtherTabs,
  closePane,
  closeTab,
  createInitialExplorerData,
  duplicateTab,
  explorerTransitions,
  moveTab,
  navigate,
  openLocation,
  pruneTabs,
  rebasePath,
  sanitizeExplorerData,
  setActivePane,
  setClipboard,
  setPaneSizes,
  setShowHidden,
  setSort,
  setViewMode,
  splitTab,
} from './explorer-workspace-model';

type Data = ExplorerWorkspaceData;

const ROOT = { nodeId: 'self', rootId: 'r1', rootPath: '/r' };

function loc(path: string, rootId = 'r1', nodeId = 'self') {
  return { nodeId, rootId, path };
}

/** 恒新开一个标签页（落在活动分栏末尾） */
function open(data: Data, tabId: string, path: string, rootId = 'r1', nodeId = 'self'): Data {
  return openLocation(data, loc(path, rootId, nodeId), { tabId, newTab: true });
}

/** p1: [a, b, c]，活动标签 c */
function threeTabs(): Data {
  let data = createInitialExplorerData('p1');
  data = open(data, 'a', '/r/a');
  data = open(data, 'b', '/r/b');
  return open(data, 'c', '/r/c');
}

/** p1: [a, b, c]（活动 c）| p2: [a2]，活动分栏 p2 */
function twoPanes(): Data {
  return splitTab(threeTabs(), 'a', { paneId: 'p2', tabId: 'a2' });
}

/** p1: [a, b, c] | p3: [b2] | p2: [a2]，活动分栏 p3 */
function threePanes(): Data {
  return splitTab(twoPanes(), 'b', { paneId: 'p3', tabId: 'b2' });
}

function tabIds(data: Data, paneId: string): string[] {
  return data.panes.find((pane) => pane.id === paneId)?.tabIds ?? [];
}

function activeTabId(data: Data, paneId: string): string | null {
  return data.panes.find((pane) => pane.id === paneId)?.activeTabId ?? null;
}

function paneIds(data: Data): string[] {
  return data.panes.map((pane) => pane.id);
}

function expectSizes(data: Data, expected: number[]) {
  expect(data.paneSizes).toHaveLength(expected.length);
  data.paneSizes.forEach((size, i) => expect(size).toBeCloseTo(expected[i], 10));
}

describe('openLocation', () => {
  test('opens a new active tab with a normalised path', () => {
    const data = openLocation(createInitialExplorerData('p1'), loc('/r//x/'), { tabId: 'a' });
    expect(data.tabs.a).toMatchObject({ id: 'a', nodeId: 'self', history: ['/r/x'], index: 0 });
    expect(data.panes).toEqual([{ id: 'p1', tabIds: ['a'], activeTabId: 'a' }]);
  });

  test('activates an existing tab at the same location, in any pane', () => {
    const data = openLocation(twoPanes(), loc('/r/b/'), { tabId: 'z' });
    expect(data.tabs.z).toBeUndefined();
    expect(activeTabId(data, 'p1')).toBe('b');
    expect(data.activePaneId).toBe('p1');
  });

  test('matches the current path only, and node + root must match too', () => {
    const moved = navigate(threeTabs(), 'a', '/r/a/deep');
    expect(openLocation(moved, loc('/r/a'), { tabId: 'z' }).tabs.z).toBeDefined();
    expect(openLocation(moved, loc('/r/b', 'r2'), { tabId: 'z' }).tabs.z.rootId).toBe('r2');
    expect(openLocation(moved, loc('/r/b', 'r1', 'n2'), { tabId: 'z' }).tabs.z.nodeId).toBe('n2');
  });

  test('newTab always opens another tab', () => {
    const data = openLocation(threeTabs(), loc('/r/a'), { tabId: 'z', newTab: true });
    expect(tabIds(data, 'p1')).toEqual(['a', 'b', 'c', 'z']);
    expect(activeTabId(data, 'p1')).toBe('z');
  });

  test('targets paneId, falling back to the active pane when unknown', () => {
    const inFirst = openLocation(twoPanes(), loc('/r/new'), { tabId: 'z', paneId: 'p1' });
    expect(tabIds(inFirst, 'p1')).toEqual(['a', 'b', 'c', 'z']);
    expect(inFirst.activePaneId).toBe('p1');

    const fallback = openLocation(twoPanes(), loc('/r/new'), { tabId: 'z', paneId: 'nope' });
    expect(tabIds(fallback, 'p2')).toEqual(['a2', 'z']);
    expect(fallback.activePaneId).toBe('p2');
  });

  test('does not mutate its input', () => {
    const before = threePanes();
    const snapshot = structuredClone(before);
    for (const [name, run] of Object.entries({
      open: () => open(before, 'z', '/r/z'),
      close: () => closeTab(before, 'b2'),
      move: () => moveTab(before, 'a2', 'p1', 0),
      pane: () => closePane(before, 'p1'),
      sizes: () => setPaneSizes(before, [2, 1, 1]),
      nav: () => navigate(before, 'a', '/r/a/x'),
      rebase: () => rebasePath(before, ROOT, '/r/a', null),
    })) {
      expect(run()).not.toBe(before);
      expect({ name, data: before }).toEqual({ name, data: snapshot });
    }
  });
});

describe('closing tabs', () => {
  test('closing the active tab picks the right neighbour, else the left', () => {
    const middle = closeTab(activateTab(threeTabs(), 'b'), 'b');
    expect(tabIds(middle, 'p1')).toEqual(['a', 'c']);
    expect(activeTabId(middle, 'p1')).toBe('c');
    expect(middle.tabs.b).toBeUndefined();

    expect(activeTabId(closeTab(threeTabs(), 'c'), 'p1')).toBe('b');
  });

  test('closing an inactive or unknown tab keeps the active one', () => {
    const data = threeTabs();
    expect(activeTabId(closeTab(data, 'a'), 'p1')).toBe('c');
    expect(closeTab(data, 'ghost')).toBe(data);
  });

  test('the last pane is emptied but never removed', () => {
    const data = closeTab(open(createInitialExplorerData('p1'), 'a', '/r'), 'a');
    expect(data.panes).toEqual([{ id: 'p1', tabIds: [], activeTabId: null }]);
    expect(data.tabs).toEqual({});
    expect(data.activePaneId).toBe('p1');
  });

  test('an emptied pane is removed when another pane exists', () => {
    const data = closeTab(twoPanes(), 'a2');
    expect(paneIds(data)).toEqual(['p1']);
    expect(data.activePaneId).toBe('p1');
    expectSizes(data, [1]);
  });

  test('closeOtherTabs only touches the tab pane', () => {
    const data = closeOtherTabs(twoPanes(), 'a');
    expect(tabIds(data, 'p1')).toEqual(['a']);
    expect(activeTabId(data, 'p1')).toBe('a');
    expect(tabIds(data, 'p2')).toEqual(['a2']);
    expect(Object.keys(data.tabs).sort()).toEqual(['a', 'a2']);

    const single = closeOtherTabs(data, 'a');
    expect(single).toBe(data);
    expect(closeOtherTabs(data, 'ghost')).toBe(data);
  });

  test('closeLocation closes every tab of that node + root and drops emptied panes', () => {
    let data = open(threeTabs(), 'x', '/other', 'r2');
    data = splitTab(data, 'x', { paneId: 'p2', tabId: 'x2' });
    expect(data.activePaneId).toBe('p2');

    const closed = closeLocation(data, 'self', 'r2');
    expect(paneIds(closed)).toEqual(['p1']);
    expect(tabIds(closed, 'p1')).toEqual(['a', 'b', 'c']);
    expect(activeTabId(closed, 'p1')).toBe('c');
    expect(closed.activePaneId).toBe('p1');
    expectSizes(closed, [1]);

    expect(closeLocation(data, 'n2', 'r2')).toBe(data);
    const all = closeLocation(closed, 'self', 'r1');
    expect(all.panes).toEqual([{ id: 'p1', tabIds: [], activeTabId: null }]);
  });

  test('pruneTabs drops tabs failing the predicate', () => {
    const data = open(threeTabs(), 'x', '/n2', 'r9', 'n2');
    const pruned = pruneTabs(data, (tab) => tab.nodeId === 'self');
    expect(tabIds(pruned, 'p1')).toEqual(['a', 'b', 'c']);
    expect(activeTabId(pruned, 'p1')).toBe('c');
    expect(pruneTabs(pruned, () => true)).toBe(pruned);
  });
});

describe('tab activation and duplication', () => {
  test('activateTab also activates its pane', () => {
    const data = activateTab(twoPanes(), 'a');
    expect(activeTabId(data, 'p1')).toBe('a');
    expect(data.activePaneId).toBe('p1');
    expect(activateTab(data, 'a')).toBe(data);
    expect(activateTab(data, 'ghost')).toBe(data);
  });

  test('setActivePane ignores unknown panes', () => {
    const data = twoPanes();
    expect(setActivePane(data, 'p1').activePaneId).toBe('p1');
    expect(setActivePane(data, 'p2')).toBe(data);
    expect(setActivePane(data, 'ghost')).toBe(data);
  });

  test('duplicateTab inserts right after the source with a fresh history', () => {
    const moved = navigate(threeTabs(), 'a', '/r/a/deep');
    const data = duplicateTab(moved, 'a', 'd');
    expect(tabIds(data, 'p1')).toEqual(['a', 'd', 'b', 'c']);
    expect(data.tabs.d).toEqual({
      id: 'd',
      nodeId: 'self',
      rootId: 'r1',
      history: ['/r/a/deep'],
      index: 0,
    });
    expect(activeTabId(data, 'p1')).toBe('d');
    expect(duplicateTab(moved, 'ghost', 'd')).toBe(moved);
  });
});

describe('moveTab', () => {
  test('reorders within a pane with index clamping', () => {
    expect(tabIds(moveTab(threeTabs(), 'a', 'p1', 2), 'p1')).toEqual(['b', 'c', 'a']);
    expect(tabIds(moveTab(threeTabs(), 'a', 'p1', 99), 'p1')).toEqual(['b', 'c', 'a']);
    expect(tabIds(moveTab(threeTabs(), 'c', 'p1', -5), 'p1')).toEqual(['c', 'a', 'b']);
    expect(tabIds(moveTab(threeTabs(), 'c', 'p1', 1), 'p1')).toEqual(['a', 'c', 'b']);
    expect(tabIds(moveTab(threeTabs(), 'a', 'p1', Number.NaN), 'p1')).toEqual(['b', 'c', 'a']);
  });

  test('the moved tab becomes active; a no-op move returns the same data', () => {
    const data = threeTabs();
    expect(activeTabId(moveTab(data, 'a', 'p1', 1), 'p1')).toBe('a');
    expect(moveTab(data, 'c', 'p1', 2)).toBe(data);
    expect(moveTab(data, 'ghost', 'p1', 0)).toBe(data);
    expect(moveTab(data, 'a', 'ghost', 0)).toBe(data);
  });

  test('moves across panes and activates the destination', () => {
    const data = moveTab(setActivePane(twoPanes(), 'p1'), 'b', 'p2', 0);
    expect(tabIds(data, 'p1')).toEqual(['a', 'c']);
    expect(activeTabId(data, 'p1')).toBe('c');
    expect(tabIds(data, 'p2')).toEqual(['b', 'a2']);
    expect(activeTabId(data, 'p2')).toBe('b');
    expect(data.activePaneId).toBe('p2');

    const clamped = moveTab(twoPanes(), 'b', 'p2', 42);
    expect(tabIds(clamped, 'p2')).toEqual(['a2', 'b']);
  });

  test('moving the active tab away hands activation to a neighbour', () => {
    const data = moveTab(twoPanes(), 'c', 'p2', 1);
    expect(tabIds(data, 'p1')).toEqual(['a', 'b']);
    expect(activeTabId(data, 'p1')).toBe('b');
  });

  test('an emptied source pane is removed', () => {
    const data = moveTab(twoPanes(), 'a2', 'p1', 1);
    expect(paneIds(data)).toEqual(['p1']);
    expect(tabIds(data, 'p1')).toEqual(['a', 'a2', 'b', 'c']);
    expect(activeTabId(data, 'p1')).toBe('a2');
    expect(data.activePaneId).toBe('p1');
    expectSizes(data, [1]);
  });
});

describe('panes', () => {
  test('splitTab opens a pane to the right holding a duplicate and halves the size', () => {
    const data = twoPanes();
    expect(paneIds(data)).toEqual(['p1', 'p2']);
    expect(data.panes[1]).toEqual({ id: 'p2', tabIds: ['a2'], activeTabId: 'a2' });
    expect(data.tabs.a2.history).toEqual(['/r/a']);
    expect(tabIds(data, 'p1')).toEqual(['a', 'b', 'c']);
    expect(data.activePaneId).toBe('p2');
    expectSizes(data, [0.5, 0.5]);

    const three = threePanes();
    expect(paneIds(three)).toEqual(['p1', 'p3', 'p2']);
    expectSizes(three, [0.25, 0.25, 0.5]);
    expect(three.activePaneId).toBe('p3');
  });

  test('splitTab is a no-op at the pane limit or for unknown tabs', () => {
    const full = threePanes();
    expect(splitTab(full, 'c', { paneId: 'p4', tabId: 'c2' })).toBe(full);
    const data = threeTabs();
    expect(splitTab(data, 'ghost', { paneId: 'p2', tabId: 'x' })).toBe(data);
  });

  test('splitting a pane already at the minimum keeps every pane above it', () => {
    const narrow = setPaneSizes(twoPanes(), [0.2, 0.8]);
    const data = splitTab(narrow, 'b', { paneId: 'p3', tabId: 'b2' });
    expectSizes(data, [0.15, 0.15, 0.7]);
  });

  test('closePane gives its size to the left neighbour, or right for the first pane', () => {
    const middle = closePane(threePanes(), 'p3');
    expect(paneIds(middle)).toEqual(['p1', 'p2']);
    expect(middle.tabs.b2).toBeUndefined();
    expectSizes(middle, [0.5, 0.5]);
    expect(middle.activePaneId).toBe('p1');

    const first = closePane(threePanes(), 'p1');
    expect(paneIds(first)).toEqual(['p3', 'p2']);
    expect(Object.keys(first.tabs).sort()).toEqual(['a2', 'b2']);
    expectSizes(first, [0.5, 0.5]);
    expect(first.activePaneId).toBe('p3');

    const last = closePane(threePanes(), 'p2');
    expectSizes(last, [0.25, 0.75]);
  });

  test('closePane never removes the last pane and ignores unknown ids', () => {
    const data = threeTabs();
    const emptied = closePane(data, 'p1');
    expect(emptied.panes).toEqual([{ id: 'p1', tabIds: [], activeTabId: null }]);
    expect(emptied.tabs).toEqual({});
    expect(closePane(emptied, 'p1')).toBe(emptied);
    expect(closePane(data, 'ghost')).toBe(data);
  });

  test('setPaneSizes normalises, clamps and rejects a wrong length', () => {
    const data = twoPanes();
    expectSizes(setPaneSizes(data, [3, 1]), [0.75, 0.25]);
    expectSizes(setPaneSizes(data, [0.95, 0.05]), [0.85, 0.15]);
    expectSizes(setPaneSizes(data, [Number.NaN, 1]), [0.5, 0.5]);
    expect(setPaneSizes(data, [1])).toBe(data);
    expect(setPaneSizes(data, [1, 1])).toBe(data);
    expectSizes(setPaneSizes(threePanes(), [1, 0, 0]), [0.7, 0.15, 0.15]);
  });
});

describe('preferences and clipboard', () => {
  test('setters update the value and skip identical writes', () => {
    const data = threeTabs();
    expect(setViewMode(data, 'grid').viewMode).toBe('grid');
    expect(setViewMode(data, 'list')).toBe(data);
    expect(setShowHidden(data, true).showHidden).toBe(true);
    expect(setShowHidden(data, false)).toBe(data);
    expect(setSort(data, { key: 'size', dir: 'desc' }).sort).toEqual({ key: 'size', dir: 'desc' });
    expect(setSort(data, { key: 'name', dir: 'asc' })).toBe(data);
  });

  test('setClipboard stores and clears', () => {
    const clipboard: ExplorerClipboard = {
      mode: 'cut',
      nodeId: 'self',
      rootId: 'r1',
      deviceId: 'local',
      paths: ['/r/a'],
    };
    const data = setClipboard(threeTabs(), clipboard);
    expect(data.clipboard).toBe(clipboard);
    expect(setClipboard(data, clipboard)).toBe(data);
    expect(setClipboard(data, null).clipboard).toBeNull();
  });
});

describe('invariants', () => {
  test('explorerTransitions exposes every transition', () => {
    expect(Object.keys(explorerTransitions)).toHaveLength(22);
    expect(explorerTransitions.navigate).toBe(navigate);
  });

  test('every reachable state survives sanitising unchanged', () => {
    const states = [threeTabs(), twoPanes(), threePanes(), closePane(threePanes(), 'p1')];
    for (const state of states) {
      expect(sanitizeExplorerData(structuredClone(state))).toEqual(state);
    }
  });
});
