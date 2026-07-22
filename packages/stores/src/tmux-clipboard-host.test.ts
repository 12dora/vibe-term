import { describe, expect, mock, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';

class MemStorage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
}

if (typeof globalThis.localStorage === 'undefined') {
  // @ts-ignore
  globalThis.localStorage = new MemStorage();
}
if (typeof globalThis.window === 'undefined') {
  // @ts-ignore
  globalThis.window = {
    localStorage: globalThis.localStorage,
    location: { origin: 'http://localhost:9663' },
  } as unknown as Window & typeof globalThis;
}

const notificationsActual = await import('@tmex/notifications');
mock.module('@tmex/notifications', () => ({
  ...notificationsActual,
  playBellSound: mock(() => {}),
}));

type MessageHandler = (msg: { kind: number; payload: Uint8Array }) => void;
const messageHandlers: MessageHandler[] = [];

const wsActual = await import('@tmex/ws-client');
mock.module('@tmex/ws-client', () => ({
  ...wsActual,
  getBorshClient: () => ({
    send: () => {},
    isReady: () => true,
    onStateChange: () => () => {},
    onMessage: (handler: MessageHandler) => {
      messageHandlers.push(handler);
      return () => {};
    },
    onError: () => () => {},
    onLatency: () => () => {},
    onChunkProgress: () => () => {},
    connect: () => {},
  }),
  getSelectStateMachine: () => ({
    dispatch: () => {},
    cleanup: () => {},
    getTransaction: () => null,
    setCallbacks: () => {},
  }),
}));

const { createAppRuntime } = await import('./index');

function dispatchClipboard(deviceId: string, paneId: string, text: string): void {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.ClipboardWriteSchema, {
    deviceId,
    paneId,
    text,
  });
  for (const handler of messageHandlers) {
    handler({ kind: wsBorsh.KIND_CLIPBOARD_WRITE, payload });
  }
}

describe('tmux clipboard write via injected host', () => {
  test('当前 pane 且可见时经 host.writeClipboardText', async () => {
    const written: string[] = [];
    Object.defineProperty(globalThis, 'document', {
      value: { visibilityState: 'visible' },
      configurable: true,
    });

    const runtime = createAppRuntime({
      storagePrefix: 'test-clip-ok:',
      t: (key) => String(key),
      notifications: {
        info: () => {},
        success: () => {},
        warning: () => {},
        error: () => {},
      },
      host: {
        navigate: () => {},
        isMobile: () => false,
        openMobileSidebar: () => {},
        closeMobileSidebar: () => {},
        writeClipboardText: async (text) => {
          written.push(text);
        },
        readClipboardText: async () => '',
        openExternal: () => {},
        reload: () => {},
        saveFile: async () => {},
      },
    });
    runtime.stores.tmux.getState().ensureSocketConnected();
    runtime.stores.tmux.setState({
      selectedPanes: { 'dev-1': { windowId: '@1', paneId: '%1' } },
    });

    dispatchClipboard('dev-1', '%1', 'remote-clip');
    // writeClipboardText 是 async；给 microtask 一轮
    await Promise.resolve();
    expect(written).toEqual(['remote-clip']);
  });

  test('非当前 pane 不写 clipboard', async () => {
    const written: string[] = [];
    Object.defineProperty(globalThis, 'document', {
      value: { visibilityState: 'visible' },
      configurable: true,
    });

    const runtime = createAppRuntime({
      storagePrefix: 'test-clip-pane:',
      t: (key) => String(key),
      notifications: {
        info: () => {},
        success: () => {},
        warning: () => {},
        error: () => {},
      },
      host: {
        navigate: () => {},
        isMobile: () => false,
        openMobileSidebar: () => {},
        closeMobileSidebar: () => {},
        writeClipboardText: async (text) => {
          written.push(text);
        },
        readClipboardText: async () => '',
        openExternal: () => {},
        reload: () => {},
        saveFile: async () => {},
      },
    });
    runtime.stores.tmux.getState().ensureSocketConnected();
    runtime.stores.tmux.setState({
      selectedPanes: { 'dev-1': { windowId: '@1', paneId: '%1' } },
    });

    dispatchClipboard('dev-1', '%2', 'other-pane');
    await Promise.resolve();
    expect(written).toEqual([]);
  });

  test('不可见时不写 clipboard', async () => {
    const written: string[] = [];
    Object.defineProperty(globalThis, 'document', {
      value: { visibilityState: 'hidden' },
      configurable: true,
    });

    const runtime = createAppRuntime({
      storagePrefix: 'test-clip-hidden:',
      t: (key) => String(key),
      notifications: {
        info: () => {},
        success: () => {},
        warning: () => {},
        error: () => {},
      },
      host: {
        navigate: () => {},
        isMobile: () => false,
        openMobileSidebar: () => {},
        closeMobileSidebar: () => {},
        writeClipboardText: async (text) => {
          written.push(text);
        },
        readClipboardText: async () => '',
        openExternal: () => {},
        reload: () => {},
        saveFile: async () => {},
      },
    });
    runtime.stores.tmux.getState().ensureSocketConnected();
    runtime.stores.tmux.setState({
      selectedPanes: { 'dev-1': { windowId: '@1', paneId: '%1' } },
    });

    dispatchClipboard('dev-1', '%1', 'hidden');
    await Promise.resolve();
    expect(written).toEqual([]);
  });
});
