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
const KIND_TMUX_EVENT = 0x0207;

function makeRuntime(hostManagedNotifications: boolean) {
  const infos: string[] = [];
  const errors: string[] = [];
  const runtime = createAppRuntime({
    storagePrefix: `test-hmn-${hostManagedNotifications}:`,
    features: { agentUi: false, hostManagedNotifications },
    t: (key) => String(key),
    notifications: {
      info: (title) => infos.push(title),
      success: () => {},
      warning: () => {},
      error: (title) => errors.push(title),
    },
  });
  runtime.stores.tmux.getState().ensureSocketConnected();
  return { runtime, infos, errors };
}

function dispatchToAll(kind: number, payload: Uint8Array): void {
  for (const handler of messageHandlers) {
    handler({ kind, payload });
  }
}

describe('hostManagedNotifications runtime feature', () => {
  test('suppresses terminal notification toast while keeping bell handling intact', async () => {
    const managed = makeRuntime(true);
    const unmanaged = makeRuntime(false);

    dispatchToAll(
      KIND_TMUX_EVENT,
      wsBorsh.encodeTmuxEventPayload({
        type: 'notification',
        deviceId: 'device-1',
        data: { source: 'osc9', title: 'Build done', body: 'exit 0' },
      })
    );

    expect(unmanaged.infos).toHaveLength(1);
    expect(managed.infos).toHaveLength(0);

    dispatchToAll(
      KIND_TMUX_EVENT,
      wsBorsh.encodeTmuxEventPayload({ type: 'bell', deviceId: 'device-1', data: { paneId: '%7' } })
    );

    const { useBellStore } = await import('@tmex/notifications');
    expect(useBellStore.getState().ringingPanes['%7']).toBe(true);
  });

  test('suppresses device error toast while keeping deviceErrors state intact', () => {
    const managed = makeRuntime(true);
    const unmanaged = makeRuntime(false);

    dispatchToAll(
      wsBorsh.KIND_DEVICE_EVENT,
      wsBorsh.encodeDeviceEventPayload({
        deviceId: 'device-err',
        type: 'error',
        errorType: 'connection_closed',
        message: 'Connection closed',
        rawMessage: 'read ECONNRESET',
      })
    );

    expect(unmanaged.errors).toEqual(['Connection closed']);
    expect(managed.errors).toHaveLength(0);
    // 错误横幅等 UI 状态两侧都照写，宿主接管只让位 toast 呈现
    for (const side of [managed, unmanaged]) {
      const state = side.runtime.stores.tmux.getState();
      expect(state.deviceErrors['device-err']?.type).toBe('connection_closed');
      expect(state.deviceErrors['device-err']?.message).toBe('Connection closed');
    }
  });
});
