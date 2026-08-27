import { afterEach, describe, expect, mock, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import type { AppRuntime } from './app-runtime';
import { installWindowStorage } from './test-utils';

installWindowStorage();

const notificationsActual = await import('@tmex/notifications');
mock.module('@tmex/notifications', () => ({
  ...notificationsActual,
  playBellSound: mock(() => {}),
}));

type MessageHandler = (msg: { kind: number; payload: Uint8Array }) => void;
const messageHandlers = new Set<MessageHandler>();

const wsActual = await import('@tmex/ws-client');
mock.module('@tmex/ws-client', () => ({
  ...wsActual,
  getBorshClient: () => ({
    send: () => {},
    isReady: () => true,
    onStateChange: () => () => {},
    onMessage: (handler: MessageHandler) => {
      messageHandlers.add(handler);
      return () => {
        messageHandlers.delete(handler);
      };
    },
    onError: () => () => {},
    onLatency: () => () => {},
    onChunkProgress: () => () => {},
    connect: () => {},
    disconnect: () => {},
    getState: () => 'READY',
    hasConnectedOnce: true,
    latencyMs: null,
    serverCapabilities: [],
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

interface ManagedRuntime {
  runtime: AppRuntime;
  infos: string[];
  errors: string[];
}

const openRuntimes: ManagedRuntime[] = [];

function makeRuntime(hostManagedNotifications: boolean): ManagedRuntime {
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
  const managed = { runtime, infos, errors };
  openRuntimes.push(managed);
  return managed;
}

function dispatchToAll(kind: number, payload: Uint8Array): void {
  for (const handler of [...messageHandlers]) {
    handler({ kind, payload });
  }
}

describe('hostManagedNotifications runtime feature', () => {
  // runtime 与其 transport 都持有 onMessage handler，不回收会让后续用例收到上一用例的事件
  afterEach(() => {
    for (const { runtime } of openRuntimes.splice(0)) {
      runtime.dispose();
      runtime.transport.dispose();
    }
    expect(messageHandlers.size).toBe(0);
  });

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
