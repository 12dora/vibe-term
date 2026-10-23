import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AppRuntime } from '@vibeterm/stores';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { createExplorerStore, explorerTabPath, getExplorerStore, resetExplorerStoreForTest } =
  await import('@vibeterm/stores/explorer');
const { openExplorerAt } = await import('./open-explorer');

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
  const storagePrefix = `open-explorer-${storageSeq++}:`;
  resetExplorerStoreForTest(createExplorerStore({ storagePrefix }));
});

afterEach(() => {
  resetExplorerStoreForTest();
});

describe('openExplorerAt', () => {
  test('在该位置开标签页，并压栈导航到管理器路由', () => {
    openExplorerAt(runtime, 'r1', '/work/pics');
    const tabs = Object.values(getExplorerStore().getState().tabs);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ nodeId: 'node-1', rootId: 'r1' });
    expect(explorerTabPath(tabs[0])).toBe('/work/pics');
    expect(navCalls).toEqual([{ to: '/explorer', opts: { replace: false } }]);
  });

  test('该位置已有标签页时聚焦它，不重复新开', () => {
    openExplorerAt(runtime, 'r1', '/work/pics');
    openExplorerAt(runtime, 'r1', '/work/pics');
    expect(Object.keys(getExplorerStore().getState().tabs)).toHaveLength(1);
    expect(navCalls).toHaveLength(2);
  });
});
