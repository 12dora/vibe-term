import { afterEach, describe, expect, test } from 'bun:test';
import {
  createExplorerStore,
  getExplorerStore,
  resetExplorerStoreForTest,
} from './explorer-workspace';
import {
  EXPLORER_MAX_PANES,
  type ExplorerClipboard,
  explorerTabPath,
  isExplorerRootOpen,
} from './explorer-workspace-model';
import { createMemoryStorage, installWindowStorage } from './test-utils';

installWindowStorage();

const CLIPBOARD: ExplorerClipboard = {
  mode: 'copy',
  nodeId: 'self',
  rootId: 'r1',
  deviceId: 'local',
  paths: ['/r/a.txt'],
};

interface PersistedBlob {
  state: Record<string, unknown>;
  version: number;
}

let storeIndex = 0;

function setup(explicitPrefix?: string) {
  storeIndex += 1;
  const prefix = explicitPrefix ?? `explorer-test-${storeIndex}-`;
  const storage = createMemoryStorage();
  const key = `${prefix}vibeterm-explorer`;
  const create = () => createExplorerStore({ storagePrefix: prefix }, { storage });
  const readPersisted = () => JSON.parse(storage.getItem(key) ?? 'null') as PersistedBlob | null;
  return { storage, key, create, readPersisted };
}

function loc(path: string, rootId = 'r1', nodeId = 'self') {
  return { nodeId, rootId, path };
}

describe('createExplorerStore actions', () => {
  test('starts with one empty pane', () => {
    const state = setup().create().getState();
    expect(state.panes).toHaveLength(1);
    expect(state.activePaneId).toBe(state.panes[0].id);
    expect(state.tabs).toEqual({});
    expect(state.clipboard).toBeNull();
  });

  test('openLocation returns the new tab id, or the existing tab at that location', () => {
    const store = setup().create();
    const first = store.getState().openLocation(loc('/r/docs/'));
    expect(explorerTabPath(store.getState().tabs[first])).toBe('/r/docs');

    const other = store.getState().openLocation(loc('/r/src'));
    expect(other).not.toBe(first);
    expect(store.getState().panes[0].activeTabId).toBe(other);

    expect(store.getState().openLocation(loc('/r/docs'))).toBe(first);
    expect(store.getState().panes[0].activeTabId).toBe(first);
    expect(Object.keys(store.getState().tabs)).toHaveLength(2);

    const forced = store.getState().openLocation(loc('/r/docs'), { newTab: true });
    expect(forced).not.toBe(first);
    expect(store.getState().panes[0].tabIds).toEqual([first, other, forced]);
  });

  test('duplicateTab and splitTab return the created ids', () => {
    const store = setup().create();
    const tabId = store.getState().openLocation(loc('/r'));

    const copy = store.getState().duplicateTab(tabId);
    expect(store.getState().panes[0].tabIds).toEqual([tabId, copy]);
    expect(store.getState().duplicateTab('ghost')).toBe('ghost');

    const paneIds = [store.getState().panes[0].id];
    while (store.getState().panes.length < EXPLORER_MAX_PANES) {
      const paneId = store.getState().splitTab(tabId);
      expect(paneId).not.toBeNull();
      paneIds.push(paneId as string);
    }
    expect(
      store
        .getState()
        .panes.map((pane) => pane.id)
        .sort()
    ).toEqual([...paneIds].sort());
    expect(store.getState().activePaneId).toBe(paneIds[paneIds.length - 1]);
    expect(store.getState().splitTab(tabId)).toBeNull();
    expect(store.getState().splitTab('ghost')).toBeNull();
  });

  test('wires navigation, rebasing and closing through to the model', () => {
    const store = setup().create();
    const tabId = store.getState().openLocation(loc('/r'));
    store.getState().navigate(tabId, '/r/old');
    store.getState().navigate(tabId, '/r/old/sub');
    store.getState().goBack(tabId);
    store.getState().goForward(tabId);
    store.getState().rebasePath('self', 'r1', '/r/old', '/r/new', '/r');
    expect(store.getState().tabs[tabId].history).toEqual(['/r', '/r/new', '/r/new/sub']);

    store.getState().rebasePath('self', 'r1', '/r/new', null, '/r');
    expect(store.getState().tabs[tabId].history).toEqual(['/r']);

    store.getState().switchRoot(tabId, 'r2', '/mnt');
    store.getState().navigate(tabId, '/mnt/a');
    store.getState().goUp(tabId, '/mnt');
    expect(explorerTabPath(store.getState().tabs[tabId])).toBe('/mnt');
    expect(isExplorerRootOpen(store.getState(), 'self', 'r2')).toBe(true);

    store.getState().closeLocation('self', 'r2');
    expect(store.getState().tabs).toEqual({});
    expect(store.getState().panes).toHaveLength(1);
  });

  test('wires pane and preference actions', () => {
    const store = setup().create();
    const a = store.getState().openLocation(loc('/r/a'));
    const b = store.getState().openLocation(loc('/r/b'));
    const paneB = store.getState().splitTab(b) as string;
    const [paneA] = store.getState().panes.map((pane) => pane.id);

    store.getState().setPaneSizes([3, 1]);
    expect(store.getState().paneSizes[0]).toBeCloseTo(0.75, 10);
    store.getState().setActivePane(paneA);
    expect(store.getState().activePaneId).toBe(paneA);
    store.getState().moveTab(a, paneB, 0);
    expect(store.getState().panes.find((pane) => pane.id === paneB)?.tabIds[0]).toBe(a);
    store.getState().activateTab(b);
    expect(store.getState().activePaneId).toBe(paneA);
    store.getState().closeOtherTabs(a);
    store.getState().closePane(paneB);
    expect(store.getState().panes.map((pane) => pane.id)).toEqual([paneA]);
    store.getState().closeTab(b);
    store.getState().pruneTabs(() => false);
    expect(store.getState().tabs).toEqual({});

    store.getState().setViewMode('grid');
    store.getState().setShowHidden(true);
    store.getState().setSort({ key: 'modifiedAt', dir: 'desc' });
    expect(store.getState()).toMatchObject({
      viewMode: 'grid',
      showHidden: true,
      sort: { key: 'modifiedAt', dir: 'desc' },
    });
  });

  test('a no-op action does not notify subscribers', () => {
    const store = setup().create();
    const tabId = store.getState().openLocation(loc('/r'));
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    store.getState().navigate(tabId, '/r/');
    store.getState().goBack(tabId);
    store.getState().activateTab(tabId);
    store.getState().closeTab('ghost');
    unsubscribe();
    expect(notified).toBe(0);
  });
});

describe('createExplorerStore persistence', () => {
  test('round-trips the workspace under the prefixed key, without the clipboard', () => {
    const { create, readPersisted } = setup('explorer-persist-');
    const store = create();
    const tabId = store.getState().openLocation(loc('/r/docs'));
    store.getState().navigate(tabId, '/r/docs/api');
    store.getState().splitTab(tabId);
    store.getState().setPaneSizes([3, 1]);
    store.getState().setViewMode('grid');
    store.getState().setShowHidden(true);
    store.getState().setSort({ key: 'size', dir: 'desc' });
    store.getState().setClipboard(CLIPBOARD);

    const persisted = readPersisted();
    expect(persisted?.version).toBe(1);
    expect(Object.keys(persisted?.state ?? {}).sort()).toEqual([
      'activePaneId',
      'paneSizes',
      'panes',
      'showHidden',
      'sort',
      'tabs',
      'viewMode',
    ]);

    const before = store.getState();
    const after = create().getState();
    expect(after.tabs).toEqual(before.tabs);
    expect(after.panes).toEqual(before.panes);
    expect(after.activePaneId).toBe(before.activePaneId);
    expect(after.paneSizes).toEqual(before.paneSizes);
    expect(after.viewMode).toBe('grid');
    expect(after.showHidden).toBe(true);
    expect(after.sort).toEqual({ key: 'size', dir: 'desc' });
    expect(after.clipboard).toBeNull();
    expect(typeof after.openLocation).toBe('function');
  });

  test('a clipboard-only change writes nothing', () => {
    const { create, storage, key } = setup();
    const store = create();
    store.getState().openLocation(loc('/r'));
    const written = storage.getItem(key);
    storage.removeItem(key);

    store.getState().setClipboard(CLIPBOARD);
    expect(storage.getItem(key)).toBeNull();
    expect(written).not.toBeNull();
  });

  test('repairs corrupted persisted state on load', () => {
    const { create, storage, key } = setup();
    storage.setItem(
      key,
      JSON.stringify({
        state: {
          tabs: {
            ok: { id: 'ok', nodeId: 'self', rootId: 'r1', history: ['/r'], index: 0 },
            broken: { id: 'broken', nodeId: 'self', rootId: 'r1', history: [], index: 0 },
          },
          panes: [{ id: 'p1', tabIds: ['broken', 'ok', 'ghost'], activeTabId: 'broken' }],
          activePaneId: 'gone',
          paneSizes: [7, 7],
          viewMode: 'tiles',
          clipboard: CLIPBOARD,
        },
        version: 1,
      })
    );

    const state = create().getState();
    expect(Object.keys(state.tabs)).toEqual(['ok']);
    expect(state.panes).toEqual([{ id: 'p1', tabIds: ['ok'], activeTabId: 'ok' }]);
    expect(state.activePaneId).toBe('p1');
    expect(state.paneSizes).toEqual([1]);
    expect(state.viewMode).toBe('list');
    expect(state.clipboard).toBeNull();
  });

  test('unreadable or version-mismatched storage still yields a usable workspace', () => {
    const garbage = setup();
    garbage.storage.setItem(garbage.key, '{not json');
    expect(garbage.create().getState().panes).toHaveLength(1);

    const legacy = setup();
    legacy.storage.setItem(
      legacy.key,
      JSON.stringify({
        state: {
          tabs: { a: { id: 'a', nodeId: 'self', rootId: 'r1', history: ['/r'], index: 0 } },
          panes: [{ id: 'p1', tabIds: ['a'], activeTabId: 'a' }],
          activePaneId: 'p1',
          paneSizes: [1],
        },
        version: 0,
      })
    );
    expect(legacy.create().getState().panes[0].tabIds).toEqual(['a']);
  });

  test('stops persisting once disposed', () => {
    const storage = createMemoryStorage();
    const disposers: Array<() => void> = [];
    const prefix = 'explorer-dispose-';
    const store = createExplorerStore({ storagePrefix: prefix }, { storage, disposers });
    expect(disposers).toHaveLength(1);
    for (const dispose of disposers) dispose();

    store.getState().openLocation(loc('/r'));
    expect(storage.getItem('explorer-dispose-vibeterm-explorer')).toBeNull();
  });

  test('defaults to window.localStorage', () => {
    const prefix = `explorer-default-storage-${Date.now()}-`;
    const store = createExplorerStore({ storagePrefix: prefix });
    const tabId = store.getState().openLocation(loc('/r'));
    expect(globalThis.localStorage.getItem(`${prefix}vibeterm-explorer`)).not.toBeNull();
    expect(createExplorerStore({ storagePrefix: prefix }).getState().tabs[tabId]).toBeDefined();
  });
});

describe('getExplorerStore singleton', () => {
  const SHARED_KEY = 'vibeterm-explorer';

  afterEach(() => {
    resetExplorerStoreForTest();
    globalThis.localStorage.removeItem(SHARED_KEY);
  });

  test('creates the store lazily and keeps returning the same instance', () => {
    resetExplorerStoreForTest();
    const store = getExplorerStore();
    expect(getExplorerStore()).toBe(store);

    const tabId = store.getState().openLocation(loc('/r', 'r1', 'node-a'));
    getExplorerStore()
      .getState()
      .openLocation(loc('/r', 'r9', 'node-b'));
    expect(isExplorerRootOpen(store.getState(), 'node-b', 'r9')).toBe(true);
    expect(getExplorerStore().getState().tabs[tabId].nodeId).toBe('node-a');
  });

  test('persists under the un-prefixed key and restores after a reset', () => {
    resetExplorerStoreForTest();
    globalThis.localStorage.removeItem(SHARED_KEY);
    const first = getExplorerStore();
    const tabId = first.getState().openLocation(loc('/r/docs'));
    first.getState().setClipboard(CLIPBOARD);

    const persisted = JSON.parse(
      globalThis.localStorage.getItem(SHARED_KEY) ?? 'null'
    ) as PersistedBlob | null;
    expect(persisted?.version).toBe(1);
    expect(Object.keys(persisted?.state ?? {})).not.toContain('clipboard');

    resetExplorerStoreForTest();
    const second = getExplorerStore();
    expect(second).not.toBe(first);
    expect(explorerTabPath(second.getState().tabs[tabId])).toBe('/r/docs');
    expect(second.getState().clipboard).toBeNull();
  });

  test('resetExplorerStoreForTest can install a specific instance', () => {
    const injected = setup().create();
    resetExplorerStoreForTest(injected);
    expect(getExplorerStore()).toBe(injected);

    resetExplorerStoreForTest();
    expect(getExplorerStore()).not.toBe(injected);
  });
});
