import { beforeEach, describe, expect, test } from 'bun:test';
import { createUIStore } from './ui';

class MemoryStorage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }
}

const storage = new MemoryStorage();
// @ts-ignore
globalThis.localStorage = storage;
if (typeof globalThis.window === 'undefined') {
  // @ts-ignore
  globalThis.window = { localStorage: storage, location: { origin: 'http://localhost:9663' } };
} else {
  // @ts-ignore
  globalThis.window.localStorage = storage;
  if (!globalThis.window.location) {
    // @ts-ignore
    globalThis.window.location = { origin: 'http://localhost:9663' };
  }
}

let storeIndex = 0;

function createStore() {
  storeIndex += 1;
  return createUIStore({ storagePrefix: `ui-sidebar-test-${storeIndex}-` });
}

describe('sidebar disclosure state', () => {
  beforeEach(() => {
    storage.clear();
  });

  test('defaults to panes and files open with agent collapsed', () => {
    expect(createStore().getState().sidebarSections).toEqual({
      panes: true,
      agent: false,
      files: true,
    });
  });

  test('keeps agent exclusive while panes and files can coexist', () => {
    const store = createStore();

    store.getState().setSidebarSectionOpen('agent', true);
    expect(store.getState().sidebarSections).toEqual({ panes: false, agent: true, files: false });

    store.getState().setSidebarSectionOpen('panes', true);
    expect(store.getState().sidebarSections).toEqual({ panes: true, agent: false, files: false });

    store.getState().setSidebarSectionOpen('files', true);
    expect(store.getState().sidebarSections).toEqual({ panes: true, agent: false, files: true });
  });

  test('closing a section affects only that section', () => {
    const store = createStore();

    store.getState().setSidebarSectionOpen('files', false);
    expect(store.getState().sidebarSections).toEqual({ panes: true, agent: false, files: false });
  });

  test('persists device disclosure and normalizes legacy overlapping sections', () => {
    const prefix = `ui-sidebar-legacy-${Date.now()}-`;
    storage.setItem(
      `${prefix}tmex-ui`,
      JSON.stringify({
        state: { sidebarSections: { panes: true, agent: true, files: true } },
        version: 0,
      })
    );

    const store = createUIStore({ storagePrefix: prefix });
    expect(store.getState().sidebarSections).toEqual({ panes: false, agent: true, files: false });

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
