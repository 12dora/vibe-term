import { describe, expect, test } from 'bun:test';

import type { TmuxConnectionOptions } from './connection-types';
import {
  type DeviceSessionRuntimeConnection,
  createDeviceSessionRuntime,
} from './device-session-runtime';
import { MetadataProjection } from './metadata-projection';
import { PaneHistoryReader } from './pane-history-reader';
import { PaneRetention } from './pane-retention';

function createStubConnectionRecorder() {
  const state = {
    connectCalls: 0,
    disconnectCalls: 0,
    requestSnapshotCalls: 0,
    sendInputCalls: [] as Array<[string, string]>,
    resizePaneCalls: [] as Array<[string, number, number]>,
    selectPaneCalls: [] as Array<[string, string]>,
    selectWindowCalls: [] as string[],
    createWindowCalls: [] as Array<[string | undefined]>,
    closeWindowCalls: [] as string[],
    closePaneCalls: [] as string[],
    splitPaneCalls: [] as Array<[string, 'h' | 'v', string | undefined]>,
    resizePaneByIdCalls: [] as Array<[string, number | undefined, number | undefined]>,
    resizeWindowCalls: [] as Array<[string, number, number]>,
    selectLayoutCalls: [] as Array<[string, string]>,
    applyStackedLayoutCalls: [] as Array<[string, number, number]>,
    focusPaneCalls: [] as Array<[string, string]>,
    movePaneCalls: [] as Array<[string, string, string]>,
    breakPaneCalls: [] as string[],
    requestPaneHistoryCalls: [] as string[],
    updateDefaultWorkingDirCalls: [] as Array<string | undefined>,
    renameWindowCalls: [] as Array<[string, string]>,
    setWindowStyleCalls: [] as string[],
    capturePaneTextCalls: [] as Array<[string, number | undefined]>,
    getPaneInfoCalls: [] as string[],
    signalThemeChangeCalls: [] as Array<[string, 'dark' | 'light']>,
    options: null as TmuxConnectionOptions | null,
  };

  let releaseConnect: (() => void) | null = null;
  const connectGate = new Promise<void>((resolve) => {
    releaseConnect = resolve;
  });

  const connection: DeviceSessionRuntimeConnection = {
    async connect() {
      state.connectCalls += 1;
      await connectGate;
    },
    disconnect() {
      state.disconnectCalls += 1;
    },
    requestSnapshot() {
      state.requestSnapshotCalls += 1;
    },
    sendInput(paneId, data) {
      state.sendInputCalls.push([paneId, data]);
    },
    resizePane(paneId, cols, rows) {
      state.resizePaneCalls.push([paneId, cols, rows]);
    },
    selectPane(windowId, paneId) {
      state.selectPaneCalls.push([windowId, paneId]);
    },
    selectPaneWithSize(windowId, paneId, cols, rows) {
      state.selectPaneCalls.push([windowId, paneId]);
      state.resizePaneCalls.push([paneId, cols, rows]);
    },
    selectWindow(windowId) {
      state.selectWindowCalls.push(windowId);
    },
    createWindow(name) {
      state.createWindowCalls.push([name]);
    },
    closeWindow(windowId) {
      state.closeWindowCalls.push(windowId);
    },
    closePane(paneId) {
      state.closePaneCalls.push(paneId);
    },
    splitPane(paneId, direction, cwd) {
      state.splitPaneCalls.push([paneId, direction, cwd]);
    },
    resizePaneById(paneId, size) {
      state.resizePaneByIdCalls.push([paneId, size.cols, size.rows]);
    },
    resizeWindow(windowId, cols, rows) {
      state.resizeWindowCalls.push([windowId, cols, rows]);
    },
    selectLayout(windowId, preset) {
      state.selectLayoutCalls.push([windowId, preset]);
    },
    applyStackedLayout(windowId, cols, rows) {
      state.applyStackedLayoutCalls.push([windowId, cols, rows]);
    },
    focusPane(windowId, paneId) {
      state.focusPaneCalls.push([windowId, paneId]);
    },
    movePane(srcPaneId, dstPaneId, position) {
      state.movePaneCalls.push([srcPaneId, dstPaneId, position]);
    },
    breakPane(paneId) {
      state.breakPaneCalls.push(paneId);
    },
    async requestPaneHistory(paneId) {
      state.requestPaneHistoryCalls.push(paneId);
    },
    async fetchPaneHistory(paneId) {
      state.requestPaneHistoryCalls.push(paneId);
      return null;
    },
    updateDefaultWorkingDir(dir) {
      state.updateDefaultWorkingDirCalls.push(dir);
    },
    renameWindow(windowId, name) {
      state.renameWindowCalls.push([windowId, name]);
    },
    async setWindowStyle(style) {
      state.setWindowStyleCalls.push(style);
    },
    async capturePaneText(paneId, opts) {
      state.capturePaneTextCalls.push([paneId, opts?.historyLines]);
      return `stub-text:${paneId}:${opts?.historyLines ?? 0}`;
    },
    async getPaneInfo(paneId) {
      state.getPaneInfoCalls.push(paneId);
      return {
        cols: 120,
        rows: 40,
        cursorX: 1,
        cursorY: 2,
        alternateScreen: false,
        currentCommand: `cmd:${paneId}`,
      };
    },
    async getPaneHistoryCaptureInfo() {
      return { historySize: 0, cols: 120 };
    },
    async capturePaneHistoryRange() {
      return '';
    },
    signalThemeChange(paneId, theme) {
      state.signalThemeChangeCalls.push([paneId, theme]);
    },
  };

  return {
    state,
    releaseConnect: () => {
      releaseConnect?.();
      releaseConnect = null;
    },
    connection,
  };
}

describe('DeviceSessionRuntime', () => {
  test('deduplicates connect calls for the same runtime instance', async () => {
    const recorder = createStubConnectionRecorder();
    const runtime = createDeviceSessionRuntime({
      deviceId: 'device-a',
      createConnection(options) {
        recorder.state.options = options;
        return recorder.connection;
      },
    });

    const first = runtime.connect();
    const second = runtime.connect();

    expect(recorder.state.connectCalls).toBe(1);

    recorder.releaseConnect();
    await Promise.all([first, second]);

    expect(recorder.state.connectCalls).toBe(1);
  });

  test('disconnect during in-flight connect stays terminated after connect resolves', async () => {
    const recorder = createStubConnectionRecorder();
    const runtime = createDeviceSessionRuntime({
      deviceId: 'device-a',
      createConnection(options) {
        recorder.state.options = options;
        return recorder.connection;
      },
    });
    const snapshots: string[] = [];
    runtime.subscribe({
      onSnapshot(payload) {
        snapshots.push(payload.deviceId);
      },
    });

    const pending = runtime.connect();
    expect(recorder.state.connectCalls).toBe(1);

    runtime.disconnect();
    expect(recorder.state.disconnectCalls).toBe(1);
    expect(runtime.isTerminated).toBe(true);

    recorder.releaseConnect();
    await pending;

    expect(runtime.isTerminated).toBe(true);
    expect(runtime.getCurrentSnapshot()).toBeNull();
    expect(snapshots).toEqual([]);
    expect(recorder.state.requestSnapshotCalls).toBe(0);
    await expect(runtime.connect()).rejects.toThrow(/already terminated/);
  });

  test('broadcasts tmux events and payloads to every subscriber', async () => {
    const recorder = createStubConnectionRecorder();
    const runtime = createDeviceSessionRuntime({
      deviceId: 'device-a',
      createConnection(options) {
        recorder.state.options = options;
        return recorder.connection;
      },
    });

    const firstEvents: string[] = [];
    const secondEvents: string[] = [];
    const firstHistory: string[] = [];
    const secondHistory: string[] = [];
    const firstSnapshots: string[] = [];
    const secondSnapshots: string[] = [];
    const firstErrors: string[] = [];
    const secondErrors: string[] = [];
    let firstClosed = 0;
    let secondClosed = 0;

    runtime.subscribe({
      onEvent(event) {
        firstEvents.push(event.type);
      },
      onTerminalOutput(paneId, data) {
        firstEvents.push(`output:${paneId}:${Array.from(data).join(',')}`);
      },
      onTerminalHistory(paneId, data) {
        firstHistory.push(`${paneId}:${data}`);
      },
      onSnapshot(payload) {
        firstSnapshots.push(payload.deviceId);
      },
      onError(error) {
        firstErrors.push(error.message);
      },
      onClose() {
        firstClosed += 1;
      },
    });

    runtime.subscribe({
      onEvent(event) {
        secondEvents.push(event.type);
      },
      onTerminalOutput(paneId, data) {
        secondEvents.push(`output:${paneId}:${Array.from(data).join(',')}`);
      },
      onTerminalHistory(paneId, data) {
        secondHistory.push(`${paneId}:${data}`);
      },
      onSnapshot(payload) {
        secondSnapshots.push(payload.deviceId);
      },
      onError(error) {
        secondErrors.push(error.message);
      },
      onClose() {
        secondClosed += 1;
      },
    });

    recorder.releaseConnect();
    await runtime.connect();

    const options = recorder.state.options;
    expect(options).not.toBeNull();

    options?.onEvent({ type: 'bell', data: { paneId: '%1' } });
    options?.onTerminalOutput('%1', new Uint8Array([0x41, 0x42]));
    options?.onTerminalHistory('%1', 'history-data', false, 0);
    options?.onSnapshot({
      deviceId: 'device-a',
      session: null,
    });
    options?.onError(new Error('boom'));
    options?.onClose();

    expect(firstEvents).toEqual(['bell', 'output:%1:65,66']);
    expect(secondEvents).toEqual(['bell', 'output:%1:65,66']);
    expect(firstHistory).toEqual(['%1:history-data']);
    expect(secondHistory).toEqual(['%1:history-data']);
    expect(firstSnapshots).toEqual(['device-a']);
    expect(secondSnapshots).toEqual(['device-a']);
    expect(firstErrors).toEqual(['boom']);
    expect(secondErrors).toEqual(['boom']);
    expect(firstClosed).toBe(1);
    expect(secondClosed).toBe(1);
  });

  test('does not rebroadcast structurally identical snapshots', () => {
    const recorder = createStubConnectionRecorder();
    const runtime = createDeviceSessionRuntime({
      deviceId: 'device-a',
      createConnection(options) {
        recorder.state.options = options;
        return recorder.connection;
      },
    });
    let snapshots = 0;
    runtime.subscribe({ onSnapshot: () => snapshots++ });
    const payload = { deviceId: 'device-a', session: null } as const;

    recorder.state.options?.onSnapshot(payload);
    recorder.state.options?.onSnapshot({ ...payload });

    expect(snapshots).toBe(1);
    runtime.disconnect();
  });

  test('keeps the compatibility snapshot on the canonical metadata revision', async () => {
    const recorder = createStubConnectionRecorder();
    const runtime = createDeviceSessionRuntime({
      deviceId: 'device-a',
      createConnection(options) {
        recorder.state.options = options;
        return recorder.connection;
      },
    });
    let snapshots = 0;
    let patches = 0;
    runtime.subscribe({
      onSnapshot: () => snapshots++,
      onMetadataPatch: () => patches++,
    });

    recorder.state.options?.onSourceReady?.(new Uint8Array(16).fill(1));
    recorder.state.options?.onSnapshot({
      deviceId: 'device-a',
      session: {
        id: '$1',
        name: 'main',
        windows: [
          {
            id: '@1',
            name: 'shell',
            index: 0,
            active: true,
            layout: 'bdbf,112x35,0,0,2',
            panes: [
              {
                id: '%2',
                windowId: '@1',
                index: 0,
                active: true,
                width: 112,
                height: 35,
                left: 0,
                top: 0,
              },
            ],
          },
        ],
      },
    });

    recorder.state.options?.onSourceMetadata?.({
      type: 'layout-change',
      windowId: '@1',
      layout: 'bf9f,92x27,0,0,2',
    });
    await Bun.sleep(30);

    const current = runtime.getCurrentSnapshot();
    expect(current?.session?.windows[0]?.layout).toBe('bf9f,92x27,0,0,2');
    expect(current?.session?.windows[0]?.panes[0]).toMatchObject({ width: 92, height: 27 });
    expect(snapshots).toBe(1);
    expect(patches).toBe(1);
    runtime.disconnect();
  });

  test('disconnects the underlying connection only once', async () => {
    const recorder = createStubConnectionRecorder();
    const runtime = createDeviceSessionRuntime({
      deviceId: 'device-a',
      createConnection(options) {
        recorder.state.options = options;
        return recorder.connection;
      },
    });

    recorder.releaseConnect();
    await runtime.connect();

    runtime.disconnect();
    runtime.disconnect();

    expect(recorder.state.disconnectCalls).toBe(1);
  });

  test('connect failure disconnects the underlying connection exactly once', async () => {
    const recorder = createStubConnectionRecorder();
    recorder.connection.connect = async () => {
      recorder.state.connectCalls += 1;
      throw new Error('ssh handshake failed');
    };
    const runtime = createDeviceSessionRuntime({
      deviceId: 'device-a',
      createConnection(options) {
        recorder.state.options = options;
        return recorder.connection;
      },
    });

    await expect(runtime.connect()).rejects.toThrow('ssh handshake failed');
    expect(recorder.state.disconnectCalls).toBe(1);
    expect(runtime.isTerminated).toBe(true);

    runtime.disconnect();
    expect(recorder.state.disconnectCalls).toBe(1);
  });

  test('connect failure does not broadcast onClose when disconnect emits close', async () => {
    const recorder = createStubConnectionRecorder();
    recorder.connection.connect = async () => {
      recorder.state.connectCalls += 1;
      throw new Error('ssh handshake failed');
    };
    const originalDisconnect = recorder.connection.disconnect;
    recorder.connection.disconnect = () => {
      originalDisconnect();
      recorder.state.options?.onClose?.();
    };
    const runtime = createDeviceSessionRuntime({
      deviceId: 'device-a',
      createConnection(options) {
        recorder.state.options = options;
        return recorder.connection;
      },
    });
    let closed = 0;
    runtime.subscribe({
      onClose() {
        closed += 1;
      },
    });

    await expect(runtime.connect()).rejects.toThrow('ssh handshake failed');
    expect(recorder.state.disconnectCalls).toBe(1);
    expect(closed).toBe(0);
    expect(runtime.isTerminated).toBe(true);
  });

  test('connect failure still rejects the original error if disconnect throws', async () => {
    const recorder = createStubConnectionRecorder();
    recorder.connection.connect = async () => {
      recorder.state.connectCalls += 1;
      throw new Error('control channel failed');
    };
    recorder.connection.disconnect = () => {
      recorder.state.disconnectCalls += 1;
      throw new Error('disconnect boom');
    };
    const runtime = createDeviceSessionRuntime({
      deviceId: 'device-a',
      createConnection(options) {
        recorder.state.options = options;
        return recorder.connection;
      },
    });

    await expect(runtime.connect()).rejects.toThrow('control channel failed');
    expect(recorder.state.disconnectCalls).toBe(1);
    expect(runtime.isTerminated).toBe(true);
  });

  test('onClose during connect still disposes runtime resources exactly once', async () => {
    const recorder = createStubConnectionRecorder();
    recorder.connection.connect = async () => {
      recorder.state.connectCalls += 1;
      recorder.state.options?.onClose?.();
      throw new Error('connect reset by peer');
    };

    const counts = { metadata: 0, retention: 0, history: 0 };
    const origMeta = MetadataProjection.prototype.dispose;
    const origRetention = PaneRetention.prototype.dispose;
    const origHistory = PaneHistoryReader.prototype.dispose;
    MetadataProjection.prototype.dispose = function (this: MetadataProjection) {
      counts.metadata += 1;
      return origMeta.call(this);
    };
    PaneRetention.prototype.dispose = function (this: PaneRetention) {
      counts.retention += 1;
      return origRetention.call(this);
    };
    PaneHistoryReader.prototype.dispose = function (this: PaneHistoryReader) {
      counts.history += 1;
      return origHistory.call(this);
    };

    try {
      const runtime = createDeviceSessionRuntime({
        deviceId: 'device-a',
        createConnection(options) {
          recorder.state.options = options;
          return recorder.connection;
        },
      });

      await expect(runtime.connect()).rejects.toThrow('connect reset by peer');
      expect(counts).toEqual({ metadata: 1, retention: 1, history: 1 });
      expect(recorder.state.disconnectCalls).toBe(1);
      expect(runtime.isTerminated).toBe(true);

      runtime.disconnect();
      expect(counts).toEqual({ metadata: 1, retention: 1, history: 1 });
      expect(recorder.state.disconnectCalls).toBe(1);
    } finally {
      MetadataProjection.prototype.dispose = origMeta;
      PaneRetention.prototype.dispose = origRetention;
      PaneHistoryReader.prototype.dispose = origHistory;
    }
  });

  test('capturePaneText delegates to the underlying connection', async () => {
    const recorder = createStubConnectionRecorder();
    const runtime = createDeviceSessionRuntime({
      deviceId: 'device-a',
      createConnection(options) {
        recorder.state.options = options;
        return recorder.connection;
      },
    });

    recorder.releaseConnect();
    await runtime.connect();

    await expect(runtime.capturePaneText('%1')).resolves.toBe('stub-text:%1:0');
    await expect(runtime.capturePaneText('%2', { historyLines: 200 })).resolves.toBe(
      'stub-text:%2:200'
    );
    expect(recorder.state.capturePaneTextCalls).toEqual([
      ['%1', undefined],
      ['%2', 200],
    ]);
  });

  test('rejects reconnect attempts after the runtime has been closed', async () => {
    const recorder = createStubConnectionRecorder();
    const runtime = createDeviceSessionRuntime({
      deviceId: 'device-a',
      createConnection(options) {
        recorder.state.options = options;
        return recorder.connection;
      },
    });

    recorder.releaseConnect();
    await runtime.connect();

    recorder.state.options?.onClose();

    let caught: Error | null = null;
    try {
      await runtime.connect();
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
    }

    expect(caught?.message ?? '').toContain('Device session runtime already terminated');
  });

  test('signalThemeChange delegates to the underlying connection', async () => {
    const recorder = createStubConnectionRecorder();
    const runtime = createDeviceSessionRuntime({
      deviceId: 'device-a',
      createConnection(options) {
        recorder.state.options = options;
        return recorder.connection;
      },
    });

    recorder.releaseConnect();
    await runtime.connect();

    runtime.signalThemeChange('%1', 'dark');
    runtime.signalThemeChange('%2', 'light');

    expect(recorder.state.signalThemeChangeCalls).toEqual([
      ['%1', 'dark'],
      ['%2', 'light'],
    ]);
  });

  test('applyStackedLayout delegates as one runtime operation', async () => {
    const recorder = createStubConnectionRecorder();
    const runtime = createDeviceSessionRuntime({
      deviceId: 'device-a',
      createConnection(options) {
        recorder.state.options = options;
        return recorder.connection;
      },
    });

    recorder.releaseConnect();
    await runtime.connect();

    (runtime as any).applyStackedLayout('@1', 85, 24);

    expect(recorder.state.applyStackedLayoutCalls).toEqual([['@1', 85, 24]]);
  });
});
