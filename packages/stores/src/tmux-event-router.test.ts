import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SELF_NODE_ID } from '@tmex/api-client';
import type { StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import type { GatewayTransportEvent } from '@tmex/ws-client';
import type { PaneSubscriptionManager } from './pane-subscriptions';
import type { RuntimeCore } from './runtime';
import type { SiteStore } from './site';
import { createTmuxEventRouter } from './tmux-event-router';
import type { TmuxSelectionActions } from './tmux-selection-actions';
import type { TmuxSetState, TmuxState } from './tmux-state';

// clipboard-write 走 document.visibilityState；仅在本文件期间注入，避免污染其它测试文件
const needsDocumentStub = typeof globalThis.document === 'undefined';

beforeAll(() => {
  if (!needsDocumentStub) return;
  Object.defineProperty(globalThis, 'document', {
    value: {
      visibilityState: 'visible',
      documentElement: { classList: { toggle: () => {}, add: () => {}, remove: () => {} } },
    },
    configurable: true,
  });
});

afterAll(() => {
  if (!needsDocumentStub) return;
  Reflect.deleteProperty(globalThis, 'document');
});

const snapshot: StateSnapshotPayload = {
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
        panes: [
          {
            id: '%1',
            windowId: '@1',
            index: 0,
            title: 'before',
            active: true,
            width: 80,
            height: 24,
          },
        ],
      },
    ],
  },
};

interface HarnessOptions {
  mountedPanes?: Array<[string, string]>;
  /** 本 runtime 服务的 node；缺省 self（entry 自身） */
  nodeId?: string;
  clipboardResult?: Promise<void>;
  /** 按尝试次数返回结果：用于「先失败、手势里重试成功」的延迟写入路径 */
  clipboardAttempt?: (attempt: number) => Promise<void>;
}

function createHarness(options: HarnessOptions = {}) {
  let state = {
    connectionState: 'IDLE',
    hasConnectedOnce: false,
    wsLatencyMs: null,
    wsLatencyRawMs: null,
    snapshots: {},
    connectedDevices: new Set<string>(),
    deviceConnected: {},
    deviceErrors: {},
    deviceReconnecting: {},
    selectedPanes: {},
    activePaneFromEvent: {},
    pendingCreateWindowAt: {},
    viewportPolicy: {},
  } as unknown as TmuxState;

  const setState: TmuxSetState = (partial) => {
    const next = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...next } as TmuxState;
  };

  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = (name: string, ...args: unknown[]): void => {
    calls.push({ name, args });
  };
  const namesOf = (name: string) => calls.filter((call) => call.name === name);

  const paneSinks = {
    dispatchPaneTerminalData: (...args: unknown[]) => record('dispatchPaneTerminalData', ...args),
    dispatchPaneScreenSnapshot: (...args: unknown[]) =>
      record('dispatchPaneScreenSnapshot', ...args),
    dispatchPaneHistoryPage: (...args: unknown[]) => record('dispatchPaneHistoryPage', ...args),
    dispatchPaneRebase: (...args: unknown[]) => record('dispatchPaneRebase', ...args),
    cleanupDevicePaneState: (...args: unknown[]) => record('cleanupDevicePaneState', ...args),
  };

  const core = {
    nodeId: options.nodeId ?? SELF_NODE_ID,
    transport: {
      capabilities: { atomicScreen: true },
      send: (command: unknown) => {
        record('send', command);
        return true;
      },
    },
    paneSinks,
    notifications: {
      info: (title: string) => record('notify:info', title),
      success: (title: string) => record('notify:success', title),
      warning: (title: string) => record('notify:warning', title),
      error: (title: string) => record('notify:error', title),
    },
    bell: { play: () => record('bell') },
    t: (key: string, params?: Record<string, unknown>) => {
      record('t', key, params);
      return key;
    },
    host: {
      navigate: (to: string) => record('navigate', to),
      writeClipboardText: (text: string) => {
        record('writeClipboardText', text);
        if (options.clipboardAttempt) {
          return options.clipboardAttempt(namesOf('writeClipboardText').length);
        }
        return options.clipboardResult ?? Promise.resolve();
      },
    },
    features: { hostManagedNotifications: false },
  } as unknown as RuntimeCore;

  const selection = {
    handleSnapshotPaneRemoval: (deviceId: string, previous: StateSnapshotPayload | undefined) =>
      record('snapshotPaneRemoval', deviceId, previous),
  } as unknown as TmuxSelectionActions;

  const paneSubscriptions = {
    forEachMountedPane: (visit: (deviceId: string, paneId: string) => void) => {
      for (const [deviceId, paneId] of options.mountedPanes ?? []) visit(deviceId, paneId);
    },
  } as unknown as PaneSubscriptionManager;

  const site = {
    getState: () => ({
      settings: undefined,
      setThemeFromS2C: (theme: string) => record('setThemeFromS2C', theme),
      handleSettingsUpdate: (namespace: string) => record('handleSettingsUpdate', namespace),
    }),
  } as unknown as SiteStore;

  const disposers: Array<() => void> = [];
  const route = createTmuxEventRouter(
    {
      core,
      getState: () => state,
      setState,
      getSite: () => site,
      selection,
      paneSubscriptions,
      onReady: () => record('ready'),
      sendWindowStyleForCurrentTheme: (deviceId: string) => record('windowStyle', deviceId),
    },
    disposers
  );

  return {
    route,
    calls,
    namesOf,
    getState: () => state,
    dispose() {
      for (const dispose of disposers.splice(0)) dispose();
    },
    setConnectedDevices(...deviceIds: string[]) {
      setState({ connectedDevices: new Set(deviceIds) });
    },
    setSelectedPane(deviceId: string, windowId: string, paneId: string) {
      setState((prev) => ({
        selectedPanes: { ...prev.selectedPanes, [deviceId]: { windowId, paneId } },
      }));
    },
  };
}

describe('tmux transport event router', () => {
  test('connection-state READY updates flags and triggers ready hook', () => {
    const harness = createHarness();

    harness.route({ type: 'connection-state', state: 'READY' });

    expect(harness.getState().connectionState).toBe('READY');
    expect(harness.getState().hasConnectedOnce).toBe(true);
    expect(harness.namesOf('ready')).toHaveLength(1);
  });

  test('latency event writes smoothed and raw fields', () => {
    const harness = createHarness();
    harness.route({ type: 'latency', latencyMs: 18, rawMs: 42 });
    expect(harness.getState().wsLatencyMs).toBe(18);
    expect(harness.getState().wsLatencyRawMs).toBe(42);
  });

  test('latency event skips store write when displayed milliseconds are unchanged', () => {
    const harness = createHarness();
    harness.route({ type: 'latency', latencyMs: 18.4, rawMs: 42.4 });
    expect(harness.getState().wsLatencyMs).toBe(18);
    expect(harness.getState().wsLatencyRawMs).toBe(42);
    const unchanged = harness.getState();

    harness.route({ type: 'latency', latencyMs: 18.1, rawMs: 42.2 });
    expect(harness.getState()).toBe(unchanged);

    harness.route({ type: 'latency', latencyMs: 19, rawMs: 42 });
    expect(harness.getState()).not.toBe(unchanged);
    expect(harness.getState().wsLatencyMs).toBe(19);
    expect(harness.getState().wsLatencyRawMs).toBe(42);
  });

  test('non-READY connection-state clears latency and keeps hasConnectedOnce', () => {
    const harness = createHarness();

    harness.route({ type: 'connection-state', state: 'READY' });
    harness.route({ type: 'latency', latencyMs: 18, rawMs: 42 });
    expect(harness.getState().wsLatencyMs).toBe(18);
    expect(harness.getState().wsLatencyRawMs).toBe(42);

    harness.route({ type: 'connection-state', state: 'RECONNECT_BACKOFF' });

    expect(harness.getState().connectionState).toBe('RECONNECT_BACKOFF');
    expect(harness.getState().hasConnectedOnce).toBe(true);
    expect(harness.getState().wsLatencyMs).toBeNull();
    expect(harness.getState().wsLatencyRawMs).toBeNull();
    expect(harness.namesOf('ready')).toHaveLength(1);
  });

  test('device-connected resets error state and syncs window style', () => {
    const harness = createHarness();

    harness.route({ type: 'device-connected', deviceId: 'device-a' });

    expect(harness.getState().deviceConnected['device-a']).toBe(true);
    expect(harness.getState().deviceErrors['device-a']).toBeUndefined();
    expect(harness.namesOf('windowStyle').map((call) => call.args[0])).toEqual(['device-a']);
  });

  test('device-disconnected 丢掉该设备的 pane 缓冲', () => {
    const harness = createHarness();

    harness.route({ type: 'device-disconnected', deviceId: 'device-a' });

    expect(harness.namesOf('cleanupDevicePaneState').map((call) => call.args[0])).toEqual([
      'device-a',
    ]);
    expect(harness.getState().deviceConnected['device-a']).toBe(false);
  });

  test('terminal-viewport-policy is stored per device:pane', () => {
    const harness = createHarness();

    harness.route({
      type: 'terminal-viewport-policy',
      kind: 'terminal-viewport-policy',
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1',
      owner: false,
      cols: 200,
      rows: 50,
    });

    expect(harness.getState().viewportPolicy['device-a:%1']).toEqual({
      owner: false,
      cols: 200,
      rows: 50,
      windowId: '@1',
    });
    // 没收到策略的 pane 保持缺省（=owner）
    expect(harness.getState().viewportPolicy['device-a:%2']).toBeUndefined();
  });

  test('device-disconnected drops the viewport policy of that device', () => {
    const harness = createHarness();

    harness.route({
      type: 'terminal-viewport-policy',
      kind: 'terminal-viewport-policy',
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1',
      owner: false,
      cols: 200,
      rows: 50,
    });
    harness.route({ type: 'device-disconnected', deviceId: 'device-a' });

    expect(harness.getState().viewportPolicy['device-a:%1']).toBeUndefined();
  });

  test('leaving READY drops the viewport policy of every connected device', () => {
    const harness = createHarness();

    harness.route({ type: 'connection-state', state: 'READY' });
    harness.setConnectedDevices('device-a');
    harness.route({
      type: 'terminal-viewport-policy',
      kind: 'terminal-viewport-policy',
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1',
      owner: false,
      cols: 200,
      rows: 50,
    });

    harness.route({ type: 'connection-state', state: 'RECONNECT_BACKOFF' });

    expect(harness.getState().viewportPolicy['device-a:%1']).toBeUndefined();
  });

  test('an auto-reconnect notice is treated as a device stream interruption', () => {
    const harness = createHarness();

    harness.route({
      type: 'device-event',
      event: {
        type: 'error',
        deviceId: 'device-a',
        errorType: 'reconnecting',
        message: 'reconnecting',
      },
    } as unknown as GatewayTransportEvent);

    expect(harness.namesOf('cleanupDevicePaneState').map((call) => call.args[0])).toEqual([
      'device-a',
    ]);
  });

  test('a device-event disconnect is treated as a device stream interruption', () => {
    const harness = createHarness();

    harness.route({
      type: 'device-event',
      event: { type: 'disconnected', deviceId: 'device-a' },
    } as unknown as GatewayTransportEvent);

    expect(harness.namesOf('cleanupDevicePaneState').map((call) => call.args[0])).toEqual([
      'device-a',
    ]);
  });

  test('device error event records error state and toasts once per error type', () => {
    const harness = createHarness();

    const errorEvent: GatewayTransportEvent = {
      type: 'device-event',
      event: {
        deviceId: 'device-a',
        type: 'error',
        errorType: 'connection_closed',
        message: 'Connection closed',
      },
    };
    harness.route(errorEvent);
    harness.route(errorEvent);

    expect(harness.getState().deviceErrors['device-a']?.type).toBe('connection_closed');
    expect(harness.namesOf('notify:error').map((call) => call.args[0])).toEqual([
      'Connection closed',
    ]);
  });

  test('metadata patch 直接替换成 ws-client 下发的整棵快照', () => {
    const harness = createHarness();
    const patched = wsBorsh.applyLegacyStateSnapshotDiff(snapshot, {
      removals: [],
      upserts: [
        {
          entityKind: wsBorsh.SOURCE_ENTITY_PANE,
          nativeId: '%1',
          parentKind: wsBorsh.SOURCE_ENTITY_WINDOW,
          parentId: '@1',
          fields: [[wsBorsh.SOURCE_FIELD_TITLE, 'after']],
        },
      ],
    });

    harness.route({ type: 'metadata-snapshot', snapshot });
    harness.route({ type: 'metadata-patch', deviceId: 'device-a', snapshot: patched });

    expect(harness.getState().snapshots['device-a']).toBe(patched);
    expect(harness.getState().snapshots['device-a']?.session?.windows[0]?.panes[0]?.title).toBe(
      'after'
    );
  });

  test('metadata snapshot reports the previous snapshot for selection reconciliation', () => {
    const harness = createHarness();

    harness.route({ type: 'metadata-snapshot', snapshot });
    harness.route({ type: 'metadata-snapshot', snapshot });

    const removals = harness.namesOf('snapshotPaneRemoval');
    expect(removals).toHaveLength(2);
    expect(removals[0]?.args).toEqual(['device-a', undefined]);
    expect(removals[1]?.args).toEqual(['device-a', snapshot]);
  });

  test('metadata patch reconciles the selection against the pre-patch snapshot', () => {
    const harness = createHarness();
    const patched = wsBorsh.applyLegacyStateSnapshotDiff(snapshot, {
      removals: [{ entityKind: wsBorsh.SOURCE_ENTITY_PANE, nativeId: '%1' }],
      upserts: [],
    });

    harness.route({ type: 'metadata-snapshot', snapshot });
    harness.route({ type: 'metadata-patch', deviceId: 'device-a', snapshot: patched });

    expect(harness.getState().snapshots['device-a']?.session?.windows[0]?.panes).toEqual([]);
    expect(harness.namesOf('snapshotPaneRemoval')[1]?.args).toEqual(['device-a', snapshot]);
  });

  test('metadata patch for unknown device is ignored', () => {
    const harness = createHarness();

    harness.route({ type: 'metadata-patch', deviceId: 'device-missing', snapshot });

    expect(harness.getState().snapshots['device-missing']).toBeUndefined();
  });

  test('terminal-data 一律路由到 pane sink', () => {
    const harness = createHarness();

    harness.route({
      type: 'terminal-data',
      frame: { deviceId: 'device-a', paneId: '%1', data: new Uint8Array([1]) },
    });
    harness.route({
      type: 'terminal-data',
      frame: { deviceId: 'device-a', paneId: '%1', data: new Uint8Array([2]), seqStart: 7n },
    });

    expect(harness.namesOf('dispatchPaneTerminalData')).toHaveLength(2);
  });

  test('server-too-old：入口网关太旧时报 Gateway 版本', () => {
    const harness = createHarness();

    expect(() =>
      harness.route({
        type: 'server-too-old',
        side: 'gateway',
        minVersion: '1.1.23',
        version: '1.1.22',
      })
    ).not.toThrow();
    expect(harness.namesOf('notify:error').map((call) => call.args[0])).toEqual([
      'websocket.gatewayTooOld',
    ]);
    expect(harness.namesOf('t').at(-1)?.args).toEqual([
      'websocket.gatewayTooOld',
      { version: '1.1.22', minVersion: '1.1.23' },
    ]);
  });

  test('server-too-old：优先点名 ERROR 里的被拒节点，而不是本 runtime 的 node', () => {
    const harness = createHarness({ nodeId: 'ffffffff0000' });

    harness.route({
      type: 'server-too-old',
      side: 'node',
      minVersion: '1.1.23',
      version: '1.1.22',
      nodeId: 'abcdef0123456789',
    });
    expect(harness.namesOf('notify:error').map((call) => call.args[0])).toEqual([
      'websocket.nodeTooOld',
    ]);
    expect(harness.namesOf('t').at(-1)?.args).toEqual([
      'websocket.nodeTooOld',
      { version: '1.1.22', minVersion: '1.1.23', name: 'abcdef01' },
    ]);
  });

  test('server-too-old：ERROR 没点名时退回本 runtime 的 node', () => {
    const harness = createHarness({ nodeId: 'abcdef0123456789' });

    harness.route({
      type: 'server-too-old',
      side: 'node',
      minVersion: '1.1.23',
      version: '1.1.22',
      nodeId: null,
    });
    expect(harness.namesOf('t').at(-1)?.args).toEqual([
      'websocket.nodeTooOld',
      { version: '1.1.22', minVersion: '1.1.23', name: 'abcdef01' },
    ]);
  });

  test('server-too-old：self runtime 上的节点错误不点名，版本未知时兜底', () => {
    const harness = createHarness();

    harness.route({
      type: 'server-too-old',
      side: 'node',
      minVersion: '1.1.23',
      version: null,
    });
    expect(harness.namesOf('notify:error').map((call) => call.args[0])).toEqual([
      'websocket.nodeTooOldUnnamed',
    ]);
    expect(harness.namesOf('t').at(-1)?.args).toEqual([
      'websocket.nodeTooOldUnnamed',
      { version: 'websocket.unknownVersion', minVersion: '1.1.23' },
    ]);
  });

  test('server-too-old：本页面太旧时只提示刷新', () => {
    const harness = createHarness();

    harness.route({
      type: 'server-too-old',
      side: 'client',
      minVersion: '1.1.23',
      version: '1.1.22',
    });
    expect(harness.namesOf('notify:error').map((call) => call.args[0])).toEqual([
      'websocket.clientTooOld',
    ]);
  });

  test('rebase-required ignores metadata gaps and broadcasts to mounted panes', () => {
    const targeted = createHarness();
    targeted.route({
      type: 'rebase-required',
      deviceId: 'device-a',
      paneId: '%1',
      reason: 'metadata_gap',
    });
    expect(targeted.namesOf('dispatchPaneRebase')).toHaveLength(0);

    targeted.route({
      type: 'rebase-required',
      deviceId: 'device-a',
      paneId: '%1',
      reason: 'epoch_changed',
    });
    expect(targeted.namesOf('dispatchPaneRebase').map((call) => call.args)).toEqual([
      ['device-a', '%1', 'epoch_changed'],
    ]);

    const broadcast = createHarness({
      mountedPanes: [
        ['device-a', '%1'],
        ['device-a', '%2'],
        ['device-b', '%3'],
      ],
    });
    broadcast.route({ type: 'rebase-required', deviceId: 'device-a', reason: 'cache_evicted' });
    expect(broadcast.namesOf('dispatchPaneRebase').map((call) => call.args)).toEqual([
      ['device-a', '%1', 'cache_evicted'],
      ['device-a', '%2', 'cache_evicted'],
    ]);
  });

  test('stores the observable feed mode and handles subscription rejection reasons separately', () => {
    const harness = createHarness();
    harness.route({ type: 'state-feed-mode', mode: 'canonical' });
    expect(harness.getState().stateFeedMode).toBe('canonical');

    harness.route({
      type: 'subscription-applied',
      deviceId: 'device-a',
      generation: 2n,
      paneIds: [],
      rejectedPaneIds: ['%missing', '%busy', '%stale'],
      rejections: [
        { deviceId: 'device-a', paneId: '%missing', reason: 'not_found' },
        { deviceId: 'device-a', paneId: '%busy', reason: 'resource_exhausted' },
        { deviceId: 'device-a', paneId: '%stale', reason: 'epoch_changed' },
      ],
    });

    expect(harness.namesOf('dispatchPaneRebase').map((call) => call.args)).toEqual([
      ['device-a', '%busy', 'resource_exhausted'],
      ['device-a', '%stale', 'epoch_changed'],
    ]);
  });

  test('clipboard-write only applies to the currently selected pane', async () => {
    const harness = createHarness();

    harness.route({ type: 'clipboard-write', deviceId: 'device-a', paneId: '%1', text: 'copied' });
    expect(harness.namesOf('writeClipboardText')).toHaveLength(0);

    harness.setSelectedPane('device-a', '@1', '%1');
    harness.route({ type: 'clipboard-write', deviceId: 'device-a', paneId: '%1', text: 'copied' });
    await Promise.resolve();

    expect(harness.namesOf('writeClipboardText').map((call) => call.args[0])).toEqual(['copied']);
    expect(harness.namesOf('notify:success').map((call) => call.args[0])).toEqual([
      'terminal.copied',
    ]);
  });

  test('clipboard-write 失败后挂起，下一次用户手势里重试成功', async () => {
    const listeners = new Map<string, Set<() => void>>();
    const windowStub = {
      addEventListener(type: string, listener: () => void) {
        const bucket = listeners.get(type) ?? new Set<() => void>();
        bucket.add(listener);
        listeners.set(type, bucket);
      },
      removeEventListener(type: string, listener: () => void) {
        listeners.get(type)?.delete(listener);
      },
    };
    Object.defineProperty(globalThis, 'window', { value: windowStub, configurable: true });

    try {
      const harness = createHarness({
        clipboardAttempt: (attempt) =>
          attempt === 1 ? Promise.reject(new Error('no user activation')) : Promise.resolve(),
      });
      harness.setSelectedPane('device-a', '@1', '%1');
      harness.route({
        type: 'clipboard-write',
        deviceId: 'device-a',
        paneId: '%1',
        text: 'copied',
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(harness.namesOf('notify:info').map((call) => call.args[0])).toEqual([
        'terminal.copyPending',
      ]);
      expect(harness.namesOf('notify:error')).toHaveLength(0);

      for (const listener of [...(listeners.get('pointerdown') ?? [])]) listener();
      await Promise.resolve();
      await Promise.resolve();

      expect(harness.namesOf('writeClipboardText').map((call) => call.args[0])).toEqual([
        'copied',
        'copied',
      ]);
      expect(harness.namesOf('notify:success').map((call) => call.args[0])).toEqual([
        'terminal.copied',
      ]);
      expect(harness.namesOf('notify:error')).toHaveLength(0);
    } finally {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });

  test('router 拆卸释放延迟剪贴板写入器：挂起监听被摘掉，后续手势不写剪贴板也不弹通知', async () => {
    const listeners = new Map<string, Set<() => void>>();
    const windowStub = {
      addEventListener(type: string, listener: () => void) {
        const bucket = listeners.get(type) ?? new Set<() => void>();
        bucket.add(listener);
        listeners.set(type, bucket);
      },
      removeEventListener(type: string, listener: () => void) {
        listeners.get(type)?.delete(listener);
      },
    };
    Object.defineProperty(globalThis, 'window', { value: windowStub, configurable: true });

    try {
      const harness = createHarness({
        clipboardAttempt: () => Promise.reject(new Error('no user activation')),
      });
      harness.setSelectedPane('device-a', '@1', '%1');
      harness.route({
        type: 'clipboard-write',
        deviceId: 'device-a',
        paneId: '%1',
        text: 'copied',
      });
      await Promise.resolve();
      await Promise.resolve();

      const pending = [...(listeners.get('pointerdown') ?? [])];
      expect(pending).toHaveLength(1);
      expect(harness.namesOf('notify:info')).toHaveLength(1);

      harness.dispose();
      expect([...(listeners.get('pointerdown') ?? [])]).toHaveLength(0);

      for (const listener of pending) listener();
      await Promise.resolve();
      await Promise.resolve();

      expect(harness.namesOf('writeClipboardText')).toHaveLength(1);
      expect(harness.namesOf('notify:success')).toHaveLength(0);
      expect(harness.namesOf('notify:error')).toHaveLength(0);
    } finally {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });

  test('clipboard-write failure surfaces an error toast', async () => {
    const harness = createHarness({ clipboardResult: Promise.reject(new Error('denied')) });
    harness.setSelectedPane('device-a', '@1', '%1');

    harness.route({ type: 'clipboard-write', deviceId: 'device-a', paneId: '%1', text: 'copied' });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.namesOf('notify:error').map((call) => call.args[0])).toEqual([
      'terminal.copyFailed',
    ]);
  });

  test('site-theme-update is forwarded to the site store', () => {
    const harness = createHarness();

    harness.route({ type: 'site-theme-update', theme: 'light' });

    expect(harness.namesOf('setThemeFromS2C').map((call) => call.args[0])).toEqual(['light']);
  });

  test('settings-update is forwarded to the site store with its namespace', () => {
    const harness = createHarness();

    harness.route({ type: 'settings-update', namespace: 'site' });
    harness.route({ type: 'settings-update', namespace: 'llm' });

    expect(harness.namesOf('handleSettingsUpdate').map((call) => call.args[0])).toEqual([
      'site',
      'llm',
    ]);
  });

  test('tmux pane-active event records the active pane', () => {
    const harness = createHarness();

    harness.route({
      type: 'tmux-event',
      event: { deviceId: 'device-a', type: 'pane-active', data: { windowId: '@2', paneId: '%9' } },
    });

    expect(harness.getState().activePaneFromEvent['device-a']).toEqual({
      windowId: '@2',
      paneId: '%9',
    });
  });

  test('unknown event types are handled without throwing', () => {
    const harness = createHarness();

    expect(() =>
      harness.route({ type: 'not-a-real-event' } as unknown as GatewayTransportEvent)
    ).not.toThrow();
    harness.route({
      type: 'pending-overflow',
      kind: 0x0301,
      pendingFrames: 0,
      pendingBytes: 0,
      droppedFrames: 2,
    } as GatewayTransportEvent);
    expect(harness.namesOf('notify:error').map((call) => call.args[0])).toContain(
      'websocket.inputDropped'
    );
  });
});
