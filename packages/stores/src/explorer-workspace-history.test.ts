import { describe, expect, test } from 'bun:test';
import {
  EXPLORER_HISTORY_LIMIT,
  type ExplorerWorkspaceData,
  createInitialExplorerData,
  explorerTabPath,
  goBack,
  goForward,
  goUp,
  navigate,
  openLocation,
  rebasePath,
  switchRoot,
} from './explorer-workspace-model';

type Data = ExplorerWorkspaceData;

const ROOT = { nodeId: 'self', rootId: 'r1', rootPath: '/r' };

/** 恒新开一个标签页（落在活动分栏末尾） */
function open(data: Data, tabId: string, path: string, rootId = 'r1', nodeId = 'self'): Data {
  return openLocation(data, { nodeId, rootId, path }, { tabId, newTab: true });
}

/** p1: [a, b, c]，活动标签 c */
function threeTabs(): Data {
  let data = createInitialExplorerData('p1');
  data = open(data, 'a', '/r/a');
  data = open(data, 'b', '/r/b');
  return open(data, 'c', '/r/c');
}

function withHistory(data: Data, tabId: string, history: string[], index: number): Data {
  return { ...data, tabs: { ...data.tabs, [tabId]: { ...data.tabs[tabId], history, index } } };
}

describe('history', () => {
  test('navigate pushes and truncates forward history', () => {
    let data = navigate(threeTabs(), 'a', '/r/a/x/');
    data = navigate(data, 'a', '/r/a/x/y');
    expect(data.tabs.a.history).toEqual(['/r/a', '/r/a/x', '/r/a/x/y']);
    expect(data.tabs.a.index).toBe(2);

    data = goBack(goBack(data, 'a'), 'a');
    data = navigate(data, 'a', '/r/a/z');
    expect(data.tabs.a.history).toEqual(['/r/a', '/r/a/z']);
    expect(data.tabs.a.index).toBe(1);
  });

  test('navigate to the current path or an unknown tab is a no-op', () => {
    const data = threeTabs();
    expect(navigate(data, 'a', '/r/a/')).toBe(data);
    expect(navigate(data, 'ghost', '/r/x')).toBe(data);
  });

  test('navigate enforces the history limit', () => {
    let data = threeTabs();
    for (let i = 0; i < 60; i += 1) data = navigate(data, 'a', `/r/d${i}`);
    expect(data.tabs.a.history).toHaveLength(EXPLORER_HISTORY_LIMIT);
    expect(data.tabs.a.index).toBe(EXPLORER_HISTORY_LIMIT - 1);
    expect(data.tabs.a.history[0]).toBe('/r/d10');
    expect(explorerTabPath(data.tabs.a)).toBe('/r/d59');
  });

  test('goBack / goForward stop at the bounds', () => {
    const start = navigate(threeTabs(), 'a', '/r/a/x');
    expect(goForward(start, 'a')).toBe(start);

    const back = goBack(start, 'a');
    expect(explorerTabPath(back.tabs.a)).toBe('/r/a');
    expect(back.tabs.a.history).toEqual(['/r/a', '/r/a/x']);
    expect(goBack(back, 'a')).toBe(back);

    expect(explorerTabPath(goForward(back, 'a').tabs.a)).toBe('/r/a/x');
    expect(goBack(start, 'ghost')).toBe(start);
  });

  test('goUp pushes the parent and stops at the root', () => {
    const deep = navigate(threeTabs(), 'a', '/r/a/x');
    const up = goUp(deep, 'a', '/r/a/');
    expect(up.tabs.a.history).toEqual(['/r/a', '/r/a/x', '/r/a']);
    expect(up.tabs.a.index).toBe(2);
    expect(goUp(up, 'a', '/r/a')).toBe(up);

    const slashRoot = goUp(open(createInitialExplorerData('p1'), 't', '/x'), 't', '/');
    expect(explorerTabPath(slashRoot.tabs.t)).toBe('/');
    expect(goUp(slashRoot, 't', '/')).toBe(slashRoot);
  });

  test('switchRoot resets the history on the new root', () => {
    const data = switchRoot(navigate(threeTabs(), 'a', '/r/a/x'), 'a', 'r2', '/mnt/data/');
    expect(data.tabs.a).toEqual({
      id: 'a',
      nodeId: 'self',
      rootId: 'r2',
      history: ['/mnt/data'],
      index: 0,
    });
    expect(switchRoot(data, 'a', 'r2', '/mnt/data')).toBe(data);
    expect(switchRoot(data, 'ghost', 'r2', '/mnt/data')).toBe(data);
  });
});

describe('rebasePath', () => {
  const history = ['/r', '/r/old', '/r/old/sub', '/r/older', '/r/other'];

  test('rename rewrites entries under the old path only', () => {
    const data = rebasePath(withHistory(threeTabs(), 'a', history, 2), ROOT, '/r/old/', '/r/new');
    expect(data.tabs.a.history).toEqual(['/r', '/r/new', '/r/new/sub', '/r/older', '/r/other']);
    expect(data.tabs.a.index).toBe(2);
  });

  test('only tabs of that node + root are touched', () => {
    let data = open(threeTabs(), 'x', '/r/old', 'r2');
    data = open(data, 'y', '/r/old', 'r1', 'n2');
    const next = rebasePath(data, ROOT, '/r/old', '/r/new');
    expect(next).toBe(data);

    const mine = withHistory(data, 'a', history, 1);
    const renamed = rebasePath(mine, ROOT, '/r/old', '/r/new');
    expect(explorerTabPath(renamed.tabs.a)).toBe('/r/new');
    expect(renamed.tabs.x).toBe(mine.tabs.x);
    expect(renamed.tabs.y).toBe(mine.tabs.y);
    expect(renamed.tabs.b).toBe(mine.tabs.b);
  });

  test('renaming a path onto itself changes nothing', () => {
    const data = withHistory(threeTabs(), 'a', history, 1);
    expect(rebasePath(data, ROOT, '/r/old', '/r/old/')).toBe(data);
  });

  test('delete falls back to the nearest surviving ancestor and drops dead entries', () => {
    const data = rebasePath(withHistory(threeTabs(), 'a', history, 2), ROOT, '/r/old', null);
    expect(data.tabs.a.history).toEqual(['/r', '/r/older', '/r/other']);
    expect(data.tabs.a.index).toBe(0);

    const deep = rebasePath(withHistory(threeTabs(), 'a', ['/r/a/b/c'], 0), ROOT, '/r/a/b', null);
    expect(deep.tabs.a).toMatchObject({ history: ['/r/a'], index: 0 });
  });

  test('delete of non-current entries keeps the current one and merges duplicates', () => {
    const data = rebasePath(
      withHistory(threeTabs(), 'a', ['/r', '/r/x', '/r', '/r/y'], 3),
      ROOT,
      '/r/x',
      null
    );
    expect(data.tabs.a.history).toEqual(['/r', '/r/y']);
    expect(data.tabs.a.index).toBe(1);
  });

  test('delete never falls back above the root', () => {
    const atRoot = rebasePath(withHistory(threeTabs(), 'a', ['/r', '/r/x'], 0), ROOT, '/r', null);
    expect(atRoot.tabs.a).toMatchObject({ history: ['/r'], index: 0 });

    const above = rebasePath(withHistory(threeTabs(), 'a', ['/r/x'], 0), ROOT, '/', null);
    expect(above.tabs.a).toMatchObject({ history: ['/r'], index: 0 });
  });
});
