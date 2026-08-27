import { describe, expect, mock, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
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

function dispatchClipboard(deviceId: string, paneId: string, text: string): void {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.ClipboardWriteSchema, {
    deviceId,
    paneId,
    text,
  });
  for (const handler of [...messageHandlers]) {
    handler({ kind: wsBorsh.KIND_CLIPBOARD_WRITE, payload });
  }
}

interface ClipboardCase {
  storagePrefix: string;
  visibility: 'visible' | 'hidden';
  selectedPaneId: string;
}

/**
 * 建一个只保留剪贴板相关接线的 runtime，跑完 body 立即回收；
 * runtime 与其 transport 都注册了 onMessage handler，不回收会让下个用例收到本用例的事件。
 */
async function withClipboardRuntime(
  options: ClipboardCase,
  body: (dispatch: (paneId: string, text: string) => void) => void | Promise<void>
): Promise<string[]> {
  const written: string[] = [];
  Object.defineProperty(globalThis, 'document', {
    value: { visibilityState: options.visibility },
    configurable: true,
  });

  const runtime = createAppRuntime({
    storagePrefix: options.storagePrefix,
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

  try {
    runtime.stores.tmux.getState().ensureSocketConnected();
    runtime.stores.tmux.setState({
      selectedPanes: { 'dev-1': { windowId: '@1', paneId: options.selectedPaneId } },
    });
    await body((paneId, text) => dispatchClipboard('dev-1', paneId, text));
  } finally {
    runtime.dispose();
    runtime.transport.dispose();
  }
  return written;
}

describe('tmux clipboard write via injected host', () => {
  test('当前 pane 且可见时经 host.writeClipboardText', async () => {
    const written = await withClipboardRuntime(
      { storagePrefix: 'test-clip-ok:', visibility: 'visible', selectedPaneId: '%1' },
      async (dispatch) => {
        dispatch('%1', 'remote-clip');
        // writeClipboardText 是 async；给 microtask 一轮
        await Promise.resolve();
      }
    );
    expect(written).toEqual(['remote-clip']);
    expect(messageHandlers.size).toBe(0);
  });

  test('非当前 pane 不写 clipboard', async () => {
    const written = await withClipboardRuntime(
      { storagePrefix: 'test-clip-pane:', visibility: 'visible', selectedPaneId: '%1' },
      async (dispatch) => {
        dispatch('%2', 'other-pane');
        await Promise.resolve();
      }
    );
    expect(written).toEqual([]);
  });

  test('不可见时不写 clipboard', async () => {
    const written = await withClipboardRuntime(
      { storagePrefix: 'test-clip-hidden:', visibility: 'hidden', selectedPaneId: '%1' },
      async (dispatch) => {
        dispatch('%1', 'hidden');
        await Promise.resolve();
      }
    );
    expect(written).toEqual([]);
  });
});
