import { describe, expect, spyOn, test } from 'bun:test';
import type { StateSnapshotPayload } from '@vibeterm/shared';
import type { TmuxConnectionOptions } from './connection-types';
import {
  type DeviceSessionRuntimeConnection,
  createDeviceSessionRuntime,
} from './device-session-runtime';
import { PaneInputPacer } from './pane-input-pacer';

const mouse = '\x1b[<64;1;1M';
const bytes = (text: string) => new TextEncoder().encode(text);
const noop = () => {};

function snapshot(paneIds = ['%1']): StateSnapshotPayload {
  return {
    deviceId: 'test',
    session: {
      id: '$1',
      name: 'test',
      windows: [
        {
          id: '@1',
          name: 'test',
          index: 0,
          active: true,
          layout: '',
          panes: paneIds.map((id, index) => ({
            id,
            index,
            windowId: '@1',
            active: index === 0,
            width: 80,
            height: 24,
            left: 0,
            top: 0,
          })),
        },
      ],
    },
  };
}

function setup(binary = true) {
  let options!: TmuxConnectionOptions;
  const writes: string[] = [];
  const connection: DeviceSessionRuntimeConnection = {
    connect: async () => {},
    disconnect: noop,
    requestSnapshot: noop,
    sendInput: (_paneId, data) => {
      writes.push(data);
    },
    ...(binary
      ? {
          sendInputBytes: (_paneId: string, data: Uint8Array) => {
            writes.push(new TextDecoder().decode(data));
          },
        }
      : {}),
    resizePane: noop,
    selectPane: noop,
    selectPaneWithSize: noop,
    selectWindow: noop,
    updateDefaultWorkingDir: noop,
    createWindow: noop,
    closeWindow: noop,
    closePane: noop,
    splitPane: noop,
    resizePaneById: noop,
    resizeWindow: noop,
    selectLayout: noop,
    applyStackedLayout: noop,
    focusPane: noop,
    movePane: noop,
    breakPane: noop,
    requestPaneHistory: async () => {},
    fetchPaneHistory: async () => null,
    renameWindow: noop,
    setWindowStyle: async () => {},
    signalThemeChange: noop,
    capturePaneText: async () => '',
    getPaneInfo: async () => ({
      cols: 80,
      rows: 24,
      cursorX: 0,
      cursorY: 0,
      alternateScreen: false,
      currentCommand: 'test',
    }),
    getPaneHistoryCaptureInfo: async () => ({ historySize: 0, cols: 80 }),
    capturePaneHistoryRange: async () => '',
  };
  const runtime = createDeviceSessionRuntime({
    deviceId: 'test',
    createConnection: (callbacks) => {
      options = callbacks;
      return connection;
    },
  });
  options.onSourceReady?.(new Uint8Array(16).fill(1));
  options.onSnapshot(snapshot());
  const send = (text: string) => runtime.sendInputBytes('%1', bytes(text));
  return { runtime, options, writes, send, connection };
}

describe('runtime mouse lane wiring', () => {
  test.each([true, false])(
    'binary=%j writes one mouse at a time and drains before ordinary input',
    (binary) => {
      const { runtime, send, writes } = setup(binary);
      try {
        send(mouse.repeat(3));
        expect(writes).toEqual([mouse]);
        send('key');
        expect(writes).toEqual([mouse, mouse, mouse, 'key']);
      } finally {
        runtime.disconnect();
      }
    }
  );
  test('string and awaited string input also drain the mouse lane', async () => {
    const { runtime, send, writes } = setup();
    try {
      await runtime.connect();
      send(mouse.repeat(2));
      runtime.sendInput('%1', 'string');
      send(mouse.repeat(2));
      await runtime.sendInputAndWait('%1', 'awaited');
      expect(writes).toEqual([mouse, mouse, 'string', mouse, mouse, 'awaited']);
    } finally {
      runtime.disconnect();
    }
  });
  test('output is fed to the lane before broadcasting unchanged bytes', () => {
    const { runtime, options } = setup();
    const calls: string[] = [];
    const output = bytes('redraw');
    const observe = spyOn(PaneInputPacer.prototype, 'onOutput').mockImplementation(
      (paneId, value) => {
        expect(paneId).toBe('%1');
        expect(value).toBe(output);
        calls.push('lane');
      }
    );
    runtime.subscribe({
      onTerminalOutput: (_pane, value) => {
        expect(value).toBe(output);
        calls.push('listener');
      },
    });
    try {
      options.onTerminalOutput('%1', output);
      expect(calls).toEqual(['lane', 'listener']);
    } finally {
      observe.mockRestore();
      runtime.disconnect();
    }
  });
  test.each(['close-pane', 'close-window', 'snapshot', 'window-event', 'source-epoch'] as const)(
    'clears queued input on %s',
    (reason) => {
      const { runtime, options, send, writes } = setup();
      try {
        send(mouse.repeat(3));
        if (reason === 'close-pane') runtime.closePane('%1');
        if (reason === 'close-window') runtime.closeWindow('@1');
        if (reason === 'snapshot') options.onSnapshot(snapshot([]));
        if (reason === 'window-event')
          options.onSourceMetadata?.({ type: 'window-close', windowId: '@1' });
        if (reason === 'source-epoch') options.onSourceReady?.(new Uint8Array(16).fill(2));
        send('key');
        expect(writes).toEqual([mouse, 'key']);
      } finally {
        runtime.disconnect();
      }
    }
  );
  test('unchanged snapshots and epochs preserve queued input', () => {
    const { runtime, options, send, writes } = setup();
    try {
      send(mouse.repeat(3));
      options.onSnapshot(snapshot());
      options.onSourceReady?.(new Uint8Array(16).fill(1));
      send('key');
      expect(writes).toEqual([mouse, mouse, mouse, 'key']);
    } finally {
      runtime.disconnect();
    }
  });
  test.each(['unmount', 'close'] as const)(
    'only the last active subscriber %s clears the lane',
    (reason) => {
      const { runtime, send, writes } = setup();
      const first = runtime.attachPaneConsumer({ onData: noop });
      const second = runtime.attachPaneConsumer({ onData: noop });
      const identity = runtime.getPaneIdentity('%1')!;
      const request = { ...identity, cursor: null };
      try {
        first.applySubscriptions(1n, [request], []);
        second.applySubscriptions(1n, [request], []);
        send(mouse.repeat(3));
        first.close();
        send('first');
        expect(writes).toEqual([mouse, mouse, mouse, 'first']);
        send(mouse.repeat(2));
        if (reason === 'close') second.close();
        else second.applySubscriptions(2n, [], [request]);
        send('last');
        expect(writes).toEqual([mouse, mouse, mouse, 'first', 'last']);
      } finally {
        first.close();
        second.close();
        runtime.disconnect();
      }
    }
  );
  test.each(['disconnect', 'unexpected-close', 'connect-error'] as const)(
    'clears queued input on %s',
    async (reason) => {
      const { runtime, options, send, writes, connection } = setup();
      try {
        send(mouse.repeat(3));
        if (reason === 'disconnect') runtime.disconnect();
        if (reason === 'unexpected-close') options.onClose();
        if (reason === 'connect-error') {
          connection.connect = async () => {
            throw new Error('connection failed');
          };
          await expect(runtime.connect()).rejects.toThrow('connection failed');
        }
        send('key');
        expect(writes).toEqual([mouse]);
      } finally {
        runtime.disconnect();
      }
    }
  );
});
