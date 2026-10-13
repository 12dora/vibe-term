import { describe, expect, test } from 'bun:test';
import {
  EXPLORER_HISTORY_LIMIT,
  EXPLORER_MAX_PANES,
  EXPLORER_MIN_PANE_FRACTION,
  type ExplorerTab,
  createExplorerId,
  createInitialExplorerData,
  explorerActiveTab,
  explorerCanGoBack,
  explorerCanGoForward,
  explorerParentPath,
  explorerTabPath,
  findExplorerTabByLocation,
  isExplorerRootOpen,
  isPathWithin,
  normalizeExplorerPaneSizes,
  normalizeExplorerPath,
} from './explorer-workspace-core';
import { sanitizeExplorerData } from './explorer-workspace-sanitize';

function tab(id: string, history: string[], index = history.length - 1): ExplorerTab {
  return { id, nodeId: 'self', rootId: 'r1', history, index };
}

function expectSizes(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((size, i) => expect(size).toBeCloseTo(expected[i], 10));
}

describe('path helpers', () => {
  test('normalizeExplorerPath resolves dots, duplicate and trailing slashes', () => {
    expect(normalizeExplorerPath('/srv//app/')).toBe('/srv/app');
    expect(normalizeExplorerPath('/srv/./app/../data')).toBe('/srv/data');
    expect(normalizeExplorerPath('/')).toBe('/');
    expect(normalizeExplorerPath('')).toBe('/');
    expect(normalizeExplorerPath('/../..')).toBe('/');
    expect(normalizeExplorerPath('srv/app')).toBe('/srv/app');
  });

  test('isPathWithin is inclusive and segment-aware', () => {
    expect(isPathWithin('/srv/app', '/srv/app')).toBe(true);
    expect(isPathWithin('/srv/app/src', '/srv/app')).toBe(true);
    expect(isPathWithin('/srv/application', '/srv/app')).toBe(false);
    expect(isPathWithin('/srv', '/srv/app')).toBe(false);
    expect(isPathWithin('/anything', '/')).toBe(true);
  });

  test('explorerParentPath stops at the root', () => {
    expect(explorerParentPath('/srv/app/src', '/srv/app')).toBe('/srv/app');
    expect(explorerParentPath('/srv/app', '/srv/app')).toBeNull();
    expect(explorerParentPath('/srv/app/', '/srv/app')).toBeNull();
    expect(explorerParentPath('/x', '/')).toBe('/');
    expect(explorerParentPath('/', '/')).toBeNull();
    expect(explorerParentPath('/elsewhere/x', '/srv/app')).toBeNull();
  });
});

describe('selectors', () => {
  test('tab path and history capabilities', () => {
    const middle = tab('a', ['/r', '/r/x', '/r/y'], 1);
    expect(explorerTabPath(middle)).toBe('/r/x');
    expect(explorerCanGoBack(middle)).toBe(true);
    expect(explorerCanGoForward(middle)).toBe(true);
    expect(explorerCanGoBack(tab('b', ['/r'], 0))).toBe(false);
    expect(explorerCanGoForward(tab('b', ['/r'], 0))).toBe(false);
  });

  test('isExplorerRootOpen matches node and root together', () => {
    const data = { tabs: { a: tab('a', ['/r']) } };
    expect(isExplorerRootOpen(data, 'self', 'r1')).toBe(true);
    expect(isExplorerRootOpen(data, 'self', 'r2')).toBe(false);
    expect(isExplorerRootOpen(data, 'other', 'r1')).toBe(false);
  });

  test('findExplorerTabByLocation compares the current path only', () => {
    const data = {
      tabs: { a: tab('a', ['/r', '/r/x'], 1), b: tab('b', ['/r']) },
      panes: [{ id: 'p1', tabIds: ['a', 'b'], activeTabId: 'a' }],
    };
    const find = (path: string, nodeId = 'self') =>
      findExplorerTabByLocation(data, { nodeId, rootId: 'r1', path });
    expect(find('/r/')?.id).toBe('b');
    expect(find('/r/x')?.id).toBe('a');
    expect(find('/r', 'n2')).toBeNull();
  });

  test('explorerActiveTab reads the active pane', () => {
    const data = {
      tabs: { a: tab('a', ['/r']), b: tab('b', ['/r/b']) },
      panes: [
        { id: 'p1', tabIds: ['a'], activeTabId: 'a' },
        { id: 'p2', tabIds: ['b'], activeTabId: 'b' },
      ],
      activePaneId: 'p2',
    };
    expect(explorerActiveTab(data)?.id).toBe('b');
    expect(explorerActiveTab({ ...data, activePaneId: 'gone' })).toBeNull();
  });
});

describe('ids and initial data', () => {
  test('createExplorerId yields distinct ids', () => {
    const ids = new Set(Array.from({ length: 20 }, () => createExplorerId()));
    expect(ids.size).toBe(20);
  });

  test('createExplorerId falls back to a counter without crypto.randomUUID', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    try {
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    } catch {
      // 运行时不允许替换全局 crypto 时无从模拟，跳过
      return;
    }
    try {
      const first = createExplorerId();
      const second = createExplorerId();
      expect(first).not.toBe(second);
      expect(first.startsWith('explorer-')).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
      else Reflect.deleteProperty(globalThis, 'crypto');
    }
  });

  test('initial data has one empty active pane and default prefs', () => {
    expect(createInitialExplorerData('p1')).toEqual({
      tabs: {},
      panes: [{ id: 'p1', tabIds: [], activeTabId: null }],
      activePaneId: 'p1',
      paneSizes: [1],
      viewMode: 'list',
      showHidden: false,
      sort: { key: 'name', dir: 'asc' },
      clipboard: null,
    });
  });
});

describe('normalizeExplorerPaneSizes', () => {
  test('scales to a sum of one', () => {
    expectSizes(normalizeExplorerPaneSizes([3, 1], 2), [0.75, 0.25]);
    expectSizes(normalizeExplorerPaneSizes([200, 200, 400], 3), [0.25, 0.25, 0.5]);
  });

  test('clamps small panes to the minimum fraction and redistributes the rest', () => {
    expectSizes(normalizeExplorerPaneSizes([0.95, 0.05], 2), [0.85, 0.15]);
    expectSizes(normalizeExplorerPaneSizes([1, 0, 0], 3), [0.7, 0.15, 0.15]);
    // 第一轮只有末项越界，把它钉住后中间项被压到下限以下，需要第二轮
    const sizes = normalizeExplorerPaneSizes([0.8, 0.16, 0.04], 3);
    expectSizes(sizes, [0.7, 0.15, 0.15]);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(EXPLORER_MIN_PANE_FRACTION);
  });

  test('falls back to equal sizes on malformed input', () => {
    expectSizes(normalizeExplorerPaneSizes([1], 2), [0.5, 0.5]);
    expectSizes(normalizeExplorerPaneSizes('nope', 2), [0.5, 0.5]);
    expectSizes(normalizeExplorerPaneSizes([Number.NaN, 1], 2), [0.5, 0.5]);
    expectSizes(normalizeExplorerPaneSizes([-1, 2], 2), [0.5, 0.5]);
    expectSizes(normalizeExplorerPaneSizes([0, 0], 2), [0.5, 0.5]);
    expectSizes(normalizeExplorerPaneSizes(['1', 1], 2), [0.5, 0.5]);
    expect(normalizeExplorerPaneSizes([], 0)).toEqual([]);
  });
});

describe('sanitizeExplorerData', () => {
  test('garbage input yields a valid empty workspace', () => {
    for (const raw of [null, undefined, 'x', 42, [], { tabs: 'x', panes: 7, sort: [] }]) {
      const data = sanitizeExplorerData(raw);
      expect(data.tabs).toEqual({});
      expect(data.panes).toHaveLength(1);
      expect(data.panes[0].tabIds).toEqual([]);
      expect(data.panes[0].activeTabId).toBeNull();
      expect(data.activePaneId).toBe(data.panes[0].id);
      expect(data.paneSizes).toEqual([1]);
      expect(data.viewMode).toBe('list');
      expect(data.showHidden).toBe(false);
      expect(data.sort).toEqual({ key: 'name', dir: 'asc' });
      expect(data.clipboard).toBeNull();
    }
  });

  test('keeps a valid workspace intact and strips the clipboard', () => {
    const valid = {
      tabs: { a: tab('a', ['/r', '/r/x'], 0), b: tab('b', ['/r/b']) },
      panes: [
        { id: 'p1', tabIds: ['a'], activeTabId: 'a' },
        { id: 'p2', tabIds: ['b'], activeTabId: 'b' },
      ],
      activePaneId: 'p2',
      paneSizes: [0.25, 0.75],
      viewMode: 'grid',
      showHidden: true,
      sort: { key: 'size', dir: 'desc' },
    };
    const clipboard = { mode: 'cut', nodeId: 'self', rootId: 'r1', deviceId: 'd', paths: ['/r'] };
    expect(sanitizeExplorerData({ ...valid, clipboard })).toEqual({ ...valid, clipboard: null });
  });

  test('drops tabs with malformed history or identity', () => {
    const data = sanitizeExplorerData({
      tabs: {
        ok: tab('ok', ['/r']),
        empty: tab('empty', []),
        relative: tab('relative', ['r/x']),
        mixed: { ...tab('mixed', ['/r']), history: ['/r', 5] },
        noHistory: { id: 'noHistory', nodeId: 'self', rootId: 'r1', index: 0 },
        noNode: { ...tab('noNode', ['/r']), nodeId: '' },
        noRoot: { ...tab('noRoot', ['/r']), rootId: 7 },
        notObject: 'tab',
      },
      panes: [
        {
          id: 'p1',
          tabIds: ['empty', 'ok', 'relative', 'mixed', 'noHistory', 'noNode', 'noRoot'],
          activeTabId: 'empty',
        },
      ],
      activePaneId: 'p1',
      paneSizes: [1],
    });
    expect(Object.keys(data.tabs)).toEqual(['ok']);
    expect(data.panes).toEqual([{ id: 'p1', tabIds: ['ok'], activeTabId: 'ok' }]);
  });

  test('repairs tab index, id and path normalisation', () => {
    const data = sanitizeExplorerData({
      tabs: {
        a: { ...tab('wrong-id', ['/r//x/', '/r/y']), index: 9 },
        b: { ...tab('b', ['/r', '/r/z']), index: 'first' },
        c: { ...tab('c', ['/r', '/r/z']), index: -3 },
      },
      panes: [{ id: 'p1', tabIds: ['a', 'b', 'c'], activeTabId: 'b' }],
      activePaneId: 'p1',
    });
    expect(data.tabs.a).toEqual({ ...tab('a', ['/r/x', '/r/y']), index: 1 });
    expect(data.tabs.b.index).toBe(1);
    expect(data.tabs.c.index).toBe(0);
    expect(data.panes[0].activeTabId).toBe('b');
  });

  test('trims over-long history to a window that keeps the current entry', () => {
    const history = Array.from({ length: 120 }, (_, i) => `/r/d${i}`);
    const data = sanitizeExplorerData({
      tabs: { a: { ...tab('a', history), index: 10 }, b: { ...tab('b', history), index: 119 } },
      panes: [{ id: 'p1', tabIds: ['a', 'b'], activeTabId: 'a' }],
    });
    expect(data.tabs.a.history).toHaveLength(EXPLORER_HISTORY_LIMIT);
    expect(explorerTabPath(data.tabs.a)).toBe('/r/d10');
    expect(data.tabs.b.history).toHaveLength(EXPLORER_HISTORY_LIMIT);
    expect(explorerTabPath(data.tabs.b)).toBe('/r/d119');
  });

  test('fixes dangling, duplicated and orphaned tab references', () => {
    const data = sanitizeExplorerData({
      tabs: { a: tab('a', ['/a']), b: tab('b', ['/b']), orphan: tab('orphan', ['/o']) },
      panes: [
        { id: 'p1', tabIds: ['a', 'ghost', 'a', 3], activeTabId: 'ghost' },
        { id: 'p2', tabIds: ['a', 'b'], activeTabId: null },
      ],
      activePaneId: 'missing',
      paneSizes: [0.5, 0.5],
    });
    expect(data.panes).toEqual([
      { id: 'p1', tabIds: ['a'], activeTabId: 'a' },
      { id: 'p2', tabIds: ['b'], activeTabId: 'b' },
    ]);
    expect(Object.keys(data.tabs).sort()).toEqual(['a', 'b']);
    expect(data.activePaneId).toBe('p1');
  });

  test('drops invalid and emptied panes and re-normalises sizes', () => {
    const data = sanitizeExplorerData({
      tabs: { a: tab('a', ['/a']), b: tab('b', ['/b']) },
      panes: [
        { id: 'p1', tabIds: ['a'], activeTabId: 'a' },
        { id: 'p2', tabIds: ['ghost'], activeTabId: 'ghost' },
        { id: 'p1', tabIds: ['b'], activeTabId: 'b' },
        { tabIds: ['b'] },
        'pane',
        { id: 'p3', tabIds: ['b'], activeTabId: 'b' },
      ],
      activePaneId: 'p2',
      paneSizes: [0.1, 0.1, 0.1, 0.1, 0.1, 0.5],
    });
    expect(data.panes.map((pane) => pane.id)).toEqual(['p1', 'p3']);
    expectSizes(data.paneSizes, [0.5, 0.5]);
    expect(data.activePaneId).toBe('p1');
  });

  test('keeps the id of an empty single pane', () => {
    const data = sanitizeExplorerData({ panes: [{ id: 'p1', tabIds: [], activeTabId: null }] });
    expect(data.panes).toEqual([{ id: 'p1', tabIds: [], activeTabId: null }]);
    expect(data.activePaneId).toBe('p1');
  });

  test('clamps to the pane limit without losing tabs', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const data = sanitizeExplorerData({
      tabs: Object.fromEntries(ids.map((id) => [id, tab(id, [`/${id}`])])),
      panes: ids.map((id, i) => ({ id: `p${i}`, tabIds: [id], activeTabId: id })),
      activePaneId: 'p4',
      paneSizes: [0.2, 0.2, 0.2, 0.2, 0.2],
    });
    expect(data.panes).toHaveLength(EXPLORER_MAX_PANES);
    expect(data.panes[2]).toEqual({ id: 'p2', tabIds: ['c', 'd', 'e'], activeTabId: 'c' });
    expect(Object.keys(data.tabs).sort()).toEqual(ids);
    expect(data.activePaneId).toBe('p0');
    expectSizes(data.paneSizes, [1 / 3, 1 / 3, 1 / 3]);
  });

  test('clamps persisted sizes and validates prefs', () => {
    const data = sanitizeExplorerData({
      tabs: { a: tab('a', ['/a']), b: tab('b', ['/b']) },
      panes: [
        { id: 'p1', tabIds: ['a'], activeTabId: 'a' },
        { id: 'p2', tabIds: ['b'], activeTabId: 'b' },
      ],
      activePaneId: 'p2',
      paneSizes: [0.99, 0.01],
      viewMode: 'tiles',
      showHidden: 'yes',
      sort: { key: 'owner', dir: 'desc' },
    });
    expectSizes(data.paneSizes, [0.85, 0.15]);
    expect(data.activePaneId).toBe('p2');
    expect(data.viewMode).toBe('list');
    expect(data.showHidden).toBe(false);
    expect(data.sort).toEqual({ key: 'name', dir: 'asc' });
    expect(sanitizeExplorerData({ sort: { key: 'kind', dir: 'sideways' } }).sort).toEqual({
      key: 'kind',
      dir: 'asc',
    });
  });
});
