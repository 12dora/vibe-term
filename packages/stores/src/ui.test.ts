import { beforeEach, describe, expect, test } from 'bun:test';
import { installWindowStorage } from './test-utils';
import { createUIStore } from './ui';

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
