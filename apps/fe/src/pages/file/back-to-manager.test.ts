import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AppRuntime } from '@vibeterm/stores';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { createExplorerStore, explorerTabPath, getExplorerStore, resetExplorerStoreForTest } =
  await import('@vibeterm/stores/explorer');
const { backToFileManager } = await import('./back-to-manager');

let storageSeq = 0;
let navCalls: Array<{ to: string; opts?: { replace?: boolean } }> = [];
const runtime = {
  nodeId: 'node-1',
  host: {
    navigate: (to: string, opts?: { replace?: boolean }) => {
      navCalls.push({ to, opts });
    },
  },
} as unknown as Pick<AppRuntime, 'nodeId' | 'host'>;

beforeEach(() => {
  navCalls = [];
  const storagePrefix = `back-to-manager-${storageSeq++}:`;
  resetExplorerStoreForTest(createExplorerStore({ storagePrefix }));
});

afterEach(() => {
  resetExplorerStoreForTest();
});

describe('backToFileManager', () => {
  test('在文件所在目录打开管理器标签页，并压栈导航到管理器路由', () => {
    backToFileManager(runtime, { rootId: 'r1', path: '/work/pics/a.png' });

    const state = getExplorerStore().getState();
    const tabs = Object.values(state.tabs);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ nodeId: 'node-1', rootId: 'r1' });
    expect(explorerTabPath(tabs[0])).toBe('/work/pics');
    expect(navCalls).toEqual([{ to: '/explorer', opts: { replace: false } }]);
  });

  test('该目录已有标签页时复用并聚焦，不重复新开', () => {
    backToFileManager(runtime, { rootId: 'r1', path: '/work/pics/a.png' });
    backToFileManager(runtime, { rootId: 'r1', path: '/work/pics/b.png' });

    expect(Object.keys(getExplorerStore().getState().tabs)).toHaveLength(1);
    expect(navCalls).toHaveLength(2);
  });

  test('根目录下的文件回到根目录', () => {
    backToFileManager(runtime, { rootId: 'r1', path: '/a.png' });
    const [tab] = Object.values(getExplorerStore().getState().tabs);
    expect(explorerTabPath(tab)).toBe('/');
  });
});
