import { beforeEach, describe, expect, test } from 'bun:test';
import { THEME_PRESETS, type ThemePreset } from '@tmex/theme';
import { installWindowStorage } from './test-utils';
import { createUIStore } from './ui';

// 名单会随版本增删，测试固定取第一个而不是写死某个 id
const VALID_PRESET: ThemePreset = THEME_PRESETS[0];

installWindowStorage();

const storage = globalThis.localStorage;

let storeIndex = 0;

function createStore() {
  storeIndex += 1;
  return createUIStore({ storagePrefix: `ui-sidebar-test-${storeIndex}-` });
}

describe('sidebar tab state', () => {
  beforeEach(() => {
    storage.clear();
  });

  test('defaults to the panes tab', () => {
    expect(createStore().getState().sidebarTab).toBe('panes');
  });

  test('switches the active tab exclusively', () => {
    const store = createStore();

    store.getState().setSidebarTab('agent');
    expect(store.getState().sidebarTab).toBe('agent');

    store.getState().setSidebarTab('files');
    expect(store.getState().sidebarTab).toBe('files');

    store.getState().setSidebarTab('panes');
    expect(store.getState().sidebarTab).toBe('panes');
  });

  test('does not persist the active tab', () => {
    const prefix = `ui-sidebar-no-persist-${Date.now()}-`;
    const store = createUIStore({ storagePrefix: prefix });
    store.getState().setSidebarTab('files');

    const persisted = JSON.parse(storage.getItem(`${prefix}tmex-ui`) ?? '{}') as {
      state?: Record<string, unknown>;
    };
    expect(persisted.state && 'sidebarTab' in persisted.state).toBe(false);

    expect(createUIStore({ storagePrefix: prefix }).getState().sidebarTab).toBe('panes');
  });

  test('ignores legacy persisted sidebarTab and sidebarSections', () => {
    const prefix = `ui-sidebar-legacy-${Date.now()}-`;
    storage.setItem(
      `${prefix}tmex-ui`,
      JSON.stringify({
        state: {
          sidebarTab: 'files',
          sidebarSections: { panes: true, agent: true, files: true },
          sidebarDeviceExpanded: { 'device-a': true },
        },
        version: 0,
      })
    );

    const store = createUIStore({ storagePrefix: prefix });
    expect(store.getState().sidebarTab).toBe('panes');
    expect(
      (store.getState() as unknown as Record<string, unknown>).sidebarSections
    ).toBeUndefined();
    expect(store.getState().sidebarDeviceExpanded).toEqual({ 'device-a': true });
  });

  test('persists device disclosure across store instances', () => {
    const prefix = `ui-sidebar-device-${Date.now()}-`;
    const store = createUIStore({ storagePrefix: prefix });

    store.getState().setSidebarDeviceExpanded('device-a', true);
    expect(store.getState().sidebarDeviceExpanded).toEqual({ 'device-a': true });

    const persisted = JSON.parse(storage.getItem(`${prefix}tmex-ui`) ?? '{}') as {
      state?: { sidebarDeviceExpanded?: Record<string, boolean> };
    };
    expect(persisted.state?.sidebarDeviceExpanded).toEqual({ 'device-a': true });

    const rehydrated = createUIStore({ storagePrefix: prefix });
    expect(rehydrated.getState().sidebarDeviceExpanded).toEqual({ 'device-a': true });
  });

  test('persists sidebar device visibility across store instances', () => {
    const prefix = `ui-sidebar-visibility-${Date.now()}-`;
    const store = createUIStore({ storagePrefix: prefix });

    expect(store.getState().sidebarDeviceVisibility).toEqual({});

    store.getState().setSidebarDeviceVisibility('node-a:device-1', true);
    store.getState().setSidebarDeviceVisibility('self:device-2', false);
    expect(store.getState().sidebarDeviceVisibility).toEqual({
      'node-a:device-1': true,
      'self:device-2': false,
    });

    const persisted = JSON.parse(storage.getItem(`${prefix}tmex-ui`) ?? '{}') as {
      state?: { sidebarDeviceVisibility?: Record<string, boolean> };
    };
    expect(persisted.state?.sidebarDeviceVisibility).toEqual({
      'node-a:device-1': true,
      'self:device-2': false,
    });

    const rehydrated = createUIStore({ storagePrefix: prefix });
    expect(rehydrated.getState().sidebarDeviceVisibility).toEqual({
      'node-a:device-1': true,
      'self:device-2': false,
    });
  });

  test('normalizes invalid persisted device visibility', () => {
    const prefix = `ui-sidebar-invalid-visibility-${Date.now()}-`;
    storage.setItem(
      `${prefix}tmex-ui`,
      JSON.stringify({
        state: { sidebarDeviceVisibility: { 'node-a:device-1': 'yes', 'node-a:device-2': true } },
        version: 0,
      })
    );

    expect(createUIStore({ storagePrefix: prefix }).getState().sidebarDeviceVisibility).toEqual({
      'node-a:device-2': true,
    });
  });

  test('normalizes invalid persisted device disclosure', () => {
    const prefix = `ui-sidebar-invalid-device-${Date.now()}-`;
    storage.setItem(
      `${prefix}tmex-ui`,
      JSON.stringify({
        state: { sidebarDeviceExpanded: null },
        version: 0,
      })
    );

    const store = createUIStore({ storagePrefix: prefix });
    expect(store.getState().sidebarDeviceExpanded).toEqual({});
  });
});

describe('sidebar collapse state', () => {
  beforeEach(() => {
    storage.clear();
  });

  test('defaults to expanded', () => {
    expect(createStore().getState().sidebarCollapsed).toBe(false);
  });

  test('persists collapse across store instances', () => {
    const prefix = `ui-sidebar-collapsed-${Date.now()}-`;
    const store = createUIStore({ storagePrefix: prefix });

    store.getState().setSidebarCollapsed(true);

    const persisted = JSON.parse(storage.getItem(`${prefix}tmex-ui`) ?? '{}') as {
      state?: { sidebarCollapsed?: boolean };
    };
    expect(persisted.state?.sidebarCollapsed).toBe(true);

    expect(createUIStore({ storagePrefix: prefix }).getState().sidebarCollapsed).toBe(true);
  });
});

describe('theme preset persistence', () => {
  beforeEach(() => {
    storage.clear();
  });

  test('defaults to no preset', () => {
    expect(createStore().getState().themePreset).toBeNull();
  });

  test('persists a valid preset across store instances', () => {
    const prefix = `ui-theme-preset-${Date.now()}-`;
    const store = createUIStore({ storagePrefix: prefix });

    store.getState().setThemePreset(VALID_PRESET);
    expect(store.getState().themePreset).toBe(VALID_PRESET);

    expect(createUIStore({ storagePrefix: prefix }).getState().themePreset).toBe(VALID_PRESET);
  });

  test('drops a persisted preset id that is no longer registered', () => {
    const prefix = `ui-theme-preset-stale-${Date.now()}-`;
    storage.setItem(
      `${prefix}tmex-ui`,
      JSON.stringify({ state: { themePreset: 'underground' }, version: 0 })
    );

    expect(createUIStore({ storagePrefix: prefix }).getState().themePreset).toBeNull();
  });

  test('drops a non-string persisted preset', () => {
    const prefix = `ui-theme-preset-garbage-${Date.now()}-`;
    storage.setItem(
      `${prefix}tmex-ui`,
      JSON.stringify({ state: { themePreset: { id: 'nope' } }, version: 0 })
    );

    expect(createUIStore({ storagePrefix: prefix }).getState().themePreset).toBeNull();
  });

  test('setThemePreset rejects unknown ids at runtime', () => {
    const store = createStore();
    store.getState().setThemePreset(VALID_PRESET);

    store.getState().setThemePreset('underground' as unknown as ThemePreset);
    expect(store.getState().themePreset).toBeNull();
  });
});

describe('cross-tab theme sync', () => {
  type StorageHandler = (event: { key: string | null; newValue: string | null }) => void;

  interface Tab {
    store: ReturnType<typeof createUIStore>;
    /** 模拟浏览器把另一标签页的写入投递给本页 */
    receiveStorageEvent(key: string): void;
  }

  // 测试环境的 window 是内存垫片，没有事件系统：临时接管 addEventListener 收集监听器
  function openTab(prefix: string): Tab {
    const win = globalThis.window as unknown as {
      addEventListener?: (type: string, handler: unknown) => void;
    };
    const original = win.addEventListener;
    const handlers: StorageHandler[] = [];
    win.addEventListener = (type: string, handler: unknown) => {
      if (type === 'storage') handlers.push(handler as StorageHandler);
    };
    const store = createUIStore({ storagePrefix: prefix });
    win.addEventListener = original;

    return {
      store,
      receiveStorageEvent(key) {
        for (const handler of handlers) {
          handler({ key, newValue: storage.getItem(key) });
        }
      },
    };
  }

  beforeEach(() => {
    storage.clear();
  });

  test('另一标签页改的外观与预设会同步进本页 store', () => {
    const prefix = `ui-theme-cross-tab-${Date.now()}-`;
    const key = `${prefix}tmex-ui`;
    storage.setItem(
      key,
      JSON.stringify({ state: { theme: 'dark', themePreset: null }, version: 0 })
    );

    const tab = openTab(prefix);
    expect(tab.store.getState().themePreset).toBeNull();

    storage.setItem(
      key,
      JSON.stringify({ state: { theme: 'light', themePreset: VALID_PRESET }, version: 0 })
    );
    tab.receiveStorageEvent(key);

    expect(tab.store.getState().theme).toBe('light');
    expect(tab.store.getState().themePreset).toBe(VALID_PRESET);
  });

  test('其它 key 的 storage 事件不影响本页', () => {
    const prefix = `ui-theme-other-key-${Date.now()}-`;
    const key = `${prefix}tmex-ui`;
    const tab = openTab(prefix);
    tab.store.getState().setThemePreset(VALID_PRESET);

    storage.setItem(key, JSON.stringify({ state: { themePreset: null }, version: 0 }));
    tab.receiveStorageEvent('unrelated-key');

    expect(tab.store.getState().themePreset).toBe(VALID_PRESET);
  });

  test('另一标签页写入的非法预设按无预设处理', () => {
    const prefix = `ui-theme-cross-tab-invalid-${Date.now()}-`;
    const key = `${prefix}tmex-ui`;
    const tab = openTab(prefix);
    tab.store.getState().setThemePreset(VALID_PRESET);

    storage.setItem(
      key,
      JSON.stringify({ state: { theme: 'dark', themePreset: 'underground' }, version: 0 })
    );
    tab.receiveStorageEvent(key);

    expect(tab.store.getState().themePreset).toBeNull();
  });

  test('syncThemeFromStorage 忽略持久化里缺失的字段', () => {
    const prefix = `ui-theme-partial-${Date.now()}-`;
    const key = `${prefix}tmex-ui`;
    const store = createUIStore({ storagePrefix: prefix });
    store.getState().setThemePreset(VALID_PRESET);

    // site store 的离线 fallback 只写 theme，不应被读成「预设已清空」
    storage.setItem(key, JSON.stringify({ state: { theme: 'light' }, version: 0 }));
    store.getState().syncThemeFromStorage();

    expect(store.getState().theme).toBe('light');
    expect(store.getState().themePreset).toBe(VALID_PRESET);
  });
});
