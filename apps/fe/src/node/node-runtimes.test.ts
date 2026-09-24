// 直连控制器的接线：非 self 的 node 才起控制器，诊断源与 bulk 客户端挂到连接上，
// 切回 primary 时补齐已订阅 pane，dispose 时一并停掉。

import { describe, expect, test } from 'bun:test';
import { writeDeviceSnapshot } from '@/pages/devices/device-snapshot-store';
import { devicesQueryKey } from '@vibeterm/api-client';
import type { MeshNode } from '@vibeterm/api-client/auth/index';
import type { Device } from '@vibeterm/shared';
import { wsBorsh } from '@vibeterm/shared';
import type { AppRuntime, AppRuntimeOptions } from '@vibeterm/stores';
import { retryNodeQuery } from '@vibeterm/stores';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import type { GatewayConnection, WebSocketLike } from '@vibeterm/ws-client';
import type { DirectCarrierController } from '@vibeterm/ws-client/direct';
import { getBulkClient } from '@vibeterm/ws-client/direct/bulk-client';
import type { DirectDiagnostics } from '@vibeterm/ws-client/direct/types';
import {
  PRIMARY_ONLY_DIAGNOSTICS,
  resolveDirectDiagnostics,
} from '@vibeterm/ws-client/direct/types';
import {
  clearDirectLinkAvailability,
  isDirectLinkUnavailable,
  markDirectLinkUnavailable,
} from './direct-link-availability';
import { resetMeshNodesStateForTest, setMeshNodesStateForTest } from './mesh-nodes';
import {
  DEVICES_STALE_MS,
  type DirectLinkModule,
  createAppNodeRuntimes,
  createNodeConnection,
  directLinkSettled,
  disposeNodeQueryClient,
  hasLoginRecovery,
  nodeQueryClient,
} from './node-runtimes';
import {
  isNodeRequestBlocked,
  noteNodeUnreachable,
  setNodeBackoffTimersForTest,
} from './node-unreachable-backoff';

/** 直连断开提示的 i18n key：locale 里已有正式条目，测试里的假 `t` 原样返回 key。 */
const DIRECT_FALLBACK_KEY = 'device.directFallbackToast';

interface FakeConnection extends GatewayConnection {
  resumeHook: (() => void) | null;
  mountedPanes: Set<string>;
  /** 把这条假连接推到 READY（直连接线等的就是这一下）。 */
  becomeReady: () => void;
}

/**
 * `ready: false` 的假连接模拟「运行时挂上了但 WS 还没开」——侧栏文件分节展开时就是这个状态。
 * 直连接线必须等到 `becomeReady()` 之后才动。
 */
function fakeConnection(mountedPanes: string[] = [], ready = true): FakeConnection {
  const mounted = new Set(mountedPanes);
  const stateListeners = new Set<(state: string) => void>();
  let isReady = ready;
  let directRetry: (() => void) | null = null;
  const connection = {
    client: {
      isReady: () => isReady,
      onStateChange: (handler: (state: string) => void) => {
        stateListeners.add(handler);
        return () => {
          stateListeners.delete(handler);
        };
      },
    } as unknown as GatewayConnection['client'],
    becomeReady: () => {
      isReady = true;
      for (const listener of [...stateListeners]) listener('READY');
    },
    transport: { stateFeedMode: 'canonical' } as GatewayConnection['transport'],
    paneSinks: {
      hasPaneSink: (_deviceId: string, paneId: string) => mounted.has(paneId),
    } as unknown as GatewayConnection['paneSinks'],
    directDiagnostics: null,
    attachDirectCarrier: () => {},
    detachDirectCarrier: () => {},
    activeCarrier: 'primary' as const,
    onCarrierChange: () => () => {},
    setResumeSubscribedPanes: (fn: (() => void) | null) => {
      connection.resumeHook = fn;
    },
    setDirectRetry: (fn: (() => void) | null) => {
      directRetry = fn;
    },
    retryDirect: () => directRetry?.(),
    dispose: () => {},
    resumeHook: null as (() => void) | null,
    mountedPanes: mounted,
  };
  return connection as unknown as FakeConnection;
}

interface FakeController {
  starts: number;
  stops: number;
  retries: number;
  explicitRetries: number;
  carrierState: 'idle' | 'connecting' | 'active' | 'failed';
  diagSnapshot: DirectDiagnostics;
  emitDiag: () => void;
  diagnosticsSource: { get: () => unknown; subscribe: (listener: () => void) => () => void };
}

/** 直连栈的最小替身：只提供宿主接线真正用到的三个符号。 */
function fakeDirectModule(): DirectLinkModule & { registered: Array<[string, unknown]> } {
  const registered: Array<[string, unknown]> = [];
  return {
    registered,
    BulkClient: class {
      constructor(readonly source: unknown) {}
    } as unknown as DirectLinkModule['BulkClient'],
    DirectCarrierController: class {
      constructor(readonly options: unknown) {}
    } as unknown as DirectLinkModule['DirectCarrierController'],
    registerBulkClient: (nodeId: string, client: unknown) => {
      registered.push([nodeId, client]);
    },
  };
}

function fakeController(): FakeController & DirectCarrierController {
  const listeners = new Set<() => void>();
  const controller = {
    starts: 0,
    stops: 0,
    diagSnapshot: { path: 'primary', route: null, rtt: null, ice: null } as DirectDiagnostics,
    emitDiag: () => {
      for (const listener of [...listeners]) listener();
    },
    diagnosticsSource: {
      get: () => controller.diagSnapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    createDataChannel: () => {
      throw new Error('direct carrier not active');
    },
    start() {
      controller.starts += 1;
    },
    stop() {
      controller.stops += 1;
    },
    retries: 0,
    explicitRetries: 0,
    carrierState: 'idle' as FakeController['carrierState'],
    retry() {
      controller.retries += 1;
    },
    retryDirect() {
      controller.explicitRetries += 1;
    },
    getState: () => controller.carrierState,
  };
  return controller as unknown as FakeController & DirectCarrierController;
}

interface ResumeCalls {
  mounts: Array<[string, string]>;
  releases: number;
  screens: Array<[string, string]>;
  warnings: string[];
}

function fakeRuntime(
  calls: ResumeCalls,
  options: { devices?: string[]; panes?: string[]; selected?: string } = {}
): AppRuntime {
  const deviceId = 'device-a';
  const panes = (options.panes ?? []).map((id, index) => ({
    id,
    windowId: '@1',
    index,
    active: index === 0,
    width: 80,
    height: 24,
  }));
  const state = {
    connectedDevices: new Set(options.devices ?? [deviceId]),
    snapshots: {
      [deviceId]: {
        deviceId,
        session: {
          id: '$0',
          name: 'main',
          windows: [{ id: '@1', name: 'w', index: 0, active: true, panes }],
        },
      },
    },
    selectedPanes: options.selected
      ? { [deviceId]: { windowId: '@1', paneId: options.selected } }
      : {},
    mountPane: (device: string, paneId: string) => {
      calls.mounts.push([device, paneId]);
      return () => {
        calls.releases += 1;
      };
    },
    requestPaneScreen: (device: string, paneId: string) => {
      calls.screens.push([device, paneId]);
    },
  };
  return {
    stores: { tmux: { getState: () => state } },
    notifications: {
      info: () => {},
      success: () => {},
      error: () => {},
      warning: (title: string) => calls.warnings.push(title),
    },
    t: (_key: string, params?: Record<string, unknown>) => String(params?.defaultValue ?? _key),
  } as unknown as AppRuntime;
}

describe('createNodeConnection', () => {
  test('self 不建直连控制器，也不挂诊断源，更不拉直连栈', () => {
    let created = 0;
    let loads = 0;
    const connection = createNodeConnection('self', {
      createConnection: () => fakeConnection(),
      loadDirect: async () => {
        loads += 1;
        return fakeDirectModule();
      },
      createController: () => {
        created += 1;
        return null;
      },
    });

    expect(created).toBe(0);
    expect(loads).toBe(0);
    expect(connection.directDiagnostics).toBeNull();
  });

  test('undefined / 空串按 self 处理，同样不建控制器', () => {
    let created = 0;
    let loads = 0;
    const wiring = {
      createConnection: () => fakeConnection(),
      loadDirect: async () => {
        loads += 1;
        return fakeDirectModule();
      },
      createController: () => {
        created += 1;
        return null;
      },
    };
    createNodeConnection('', wiring);
    expect(created).toBe(0);
    expect(loads).toBe(0);
  });

  test('非 self 的 node 才拉直连栈：建控制器、start() 并把诊断源接到 connection 上', async () => {
    const controller = fakeController();
    const nodeIds: string[] = [];
    let loads = 0;
    const connection = createNodeConnection('node-b', {
      createConnection: () => fakeConnection(),
      loadDirect: async () => {
        loads += 1;
        return fakeDirectModule();
      },
      createController: (nodeId) => {
        nodeIds.push(nodeId);
        return controller;
      },
    });

    // 加载完成前：控制器还没建，诊断源已经可订阅（UI 与建连同帧）。
    expect(nodeIds).toEqual([]);
    expect(controller.starts).toBe(0);
    expect(resolveDirectDiagnostics(connection).get()).toBe(PRIMARY_ONLY_DIAGNOSTICS);

    await directLinkSettled(connection);

    expect(loads).toBe(1);
    expect(nodeIds).toEqual(['node-b']);
    expect(controller.starts).toBe(1);
    expect(resolveDirectDiagnostics(connection).get()).toBe(controller.diagSnapshot);
  });

  test('WS 还没就绪时不拉直连栈、不起控制器；READY 之后才接线', async () => {
    const controller = fakeController();
    const connection = fakeConnection([], false);
    let loads = 0;
    createNodeConnection('node-lazy', {
      createConnection: () => connection,
      loadDirect: async () => {
        loads += 1;
        return fakeDirectModule();
      },
      createController: () => controller,
    });

    await directLinkSettled(connection);
    expect(loads).toBe(0);
    expect(controller.starts).toBe(0);
    // 诊断源与 resume 钩子仍然在建连同帧挂好，UI 不会错过订阅
    expect(connection.directDiagnostics).not.toBeNull();
    expect(connection.resumeHook).not.toBeNull();

    connection.becomeReady();
    await directLinkSettled(connection);
    expect(loads).toBe(1);
    expect(controller.starts).toBe(1);
  });

  test('pageshow / 可见恢复时直连未 active 则自动 retry（不是显式 retryDirect）；active 不拨', async () => {
    const down = fakeController();
    down.carrierState = 'failed';
    const resume: Array<() => void> = [];
    const connection = createNodeConnection('node-resume-direct', {
      createConnection: () => fakeConnection(),
      loadDirect: async () => fakeDirectModule(),
      createController: () => down,
      pageResume: (listener) => {
        resume.push(listener);
        return () => undefined;
      },
    });
    await directLinkSettled(connection);
    expect(down.retries).toBe(0);
    resume[0]?.();
    expect(down.retries).toBe(1);
    expect(down.explicitRetries).toBe(0);

    down.carrierState = 'active';
    resume[0]?.();
    expect(down.retries).toBe(1);
    connection.dispose();
  });

  test('等 READY 期间被 dispose：订阅摘掉，之后再 READY 也不起控制器', async () => {
    const controller = fakeController();
    const connection = fakeConnection([], false);
    let loads = 0;
    createNodeConnection('node-lazy-disposed', {
      createConnection: () => connection,
      loadDirect: async () => {
        loads += 1;
        return fakeDirectModule();
      },
      createController: () => controller,
    });

    connection.dispose();
    connection.becomeReady();
    await directLinkSettled(connection);

    expect(loads).toBe(0);
    expect(controller.starts).toBe(0);
  });

  test('加载前挂上的订阅者在控制器就位后收到通知', async () => {
    const controller = fakeController();
    const connection = createNodeConnection('node-b', {
      createConnection: () => fakeConnection(),
      loadDirect: async () => fakeDirectModule(),
      createController: () => controller,
    });

    let notified = 0;
    const source = resolveDirectDiagnostics(connection);
    const unsubscribe = source.subscribe(() => {
      notified += 1;
    });

    await directLinkSettled(connection);
    expect(notified).toBe(1);

    controller.diagSnapshot = { path: 'direct', route: null, rtt: null, ice: null };
    controller.emitDiag();
    expect(notified).toBe(2);
    expect(source.get()).toBe(controller.diagSnapshot);

    unsubscribe();
    connection.dispose();
    expect(source.get()).toBe(PRIMARY_ONLY_DIAGNOSTICS);
  });

  test('按 nodeId 登记 BulkClient，dispose 时注销', async () => {
    const controller = fakeController();
    const connection = createNodeConnection('node-bulk', {
      createConnection: () => fakeConnection(),
      createController: () => controller,
    });

    await directLinkSettled(connection);
    expect(getBulkClient('node-bulk')).not.toBeNull();
    connection.dispose();
    expect(getBulkClient('node-bulk')).toBeNull();
  });

  test('dispose() 先停控制器再走原始 dispose，并摘掉 resume 钩子', async () => {
    const controller = fakeController();
    const order: string[] = [];
    const base = fakeConnection();
    base.dispose = () => order.push('connection');
    controller.stop = () => {
      controller.stops += 1;
      order.push('controller');
    };

    const connection = createNodeConnection('node-b', {
      createConnection: () => base,
      loadDirect: async () => fakeDirectModule(),
      createController: () => controller,
    });
    expect(base.resumeHook).not.toBeNull();
    await directLinkSettled(connection);
    connection.dispose();

    expect(order).toEqual(['controller', 'connection']);
    expect(controller.stops).toBe(1);
    expect(base.resumeHook).toBeNull();
  });

  test('加载途中被 dispose：控制器不再创建，也没有悬挂的 bulk 登记', async () => {
    const direct = fakeDirectModule();
    let created = 0;
    const base = fakeConnection();
    const connection = createNodeConnection('node-disposed', {
      createConnection: () => base,
      loadDirect: async () => direct,
      createController: () => {
        created += 1;
        return fakeController();
      },
    });

    connection.dispose();
    await directLinkSettled(connection);

    expect(created).toBe(0);
    expect(direct.registered).toEqual([]);
    expect(getBulkClient('node-disposed')).toBeNull();
    expect(base.resumeHook).toBeNull();
    expect(resolveDirectDiagnostics(connection).get()).toBe(PRIMARY_ONLY_DIAGNOSTICS);
  });

  test('直连栈加载失败：连接留在 WS 上照常可用，下一次建连重试', async () => {
    let loads = 0;
    const first = createNodeConnection('node-chunk-404', {
      createConnection: () => fakeConnection(),
      loadDirect: async () => {
        loads += 1;
        return null;
      },
      createController: () => fakeController(),
    });

    await directLinkSettled(first);
    expect(loads).toBe(1);
    expect(getBulkClient('node-chunk-404')).toBeNull();
    expect(resolveDirectDiagnostics(first).get()).toBe(PRIMARY_ONLY_DIAGNOSTICS);
    expect(() => first.dispose()).not.toThrow();

    const controller = fakeController();
    const second = createNodeConnection('node-chunk-404', {
      createConnection: () => fakeConnection(),
      loadDirect: async () => {
        loads += 1;
        return fakeDirectModule();
      },
      createController: () => controller,
    });
    await directLinkSettled(second);

    expect(loads).toBe(2);
    expect(controller.starts).toBe(1);
  });

  test('控制器工厂返回 null（直连不可用）时连接照常可用', async () => {
    const connection = createNodeConnection('node-b', {
      createConnection: () => fakeConnection(),
      loadDirect: async () => fakeDirectModule(),
      createController: () => null,
    });
    await directLinkSettled(connection);
    expect(resolveDirectDiagnostics(connection).get()).toBe(PRIMARY_ONLY_DIAGNOSTICS);
  });

  test('这条入口最近答过「给不出直连」：负缓存命中就不再建控制器', async () => {
    // 负缓存按 entry+node 记账，入口身份未知时既不记也不查，所以得先有入口 id。
    setMeshNodesStateForTest({ entryNodeId: 'entry-node', nodes: [] });
    markDirectLinkUnavailable('node-b', 'entry-node');
    let created = 0;
    const connection = createNodeConnection('node-b', {
      createConnection: () => fakeConnection(),
      loadDirect: async () => fakeDirectModule(),
      createController: () => {
        created += 1;
        return fakeController();
      },
    });
    await directLinkSettled(connection);

    expect(created).toBe(0);
    expect(resolveDirectDiagnostics(connection).get()).toBe(PRIMARY_ONLY_DIAGNOSTICS);
    clearDirectLinkAvailability();
    resetMeshNodesStateForTest();
  });

  test('负缓存停放的直连：过期前 READY / 页面恢复都不起，过期后下一次信号才起', async () => {
    setMeshNodesStateForTest({ entryNodeId: 'entry-node', nodes: [] });
    markDirectLinkUnavailable('node-parked', 'entry-node');
    let created = 0;
    const resume: Array<() => void> = [];
    const raw = fakeConnection();
    const connection = createNodeConnection('node-parked', {
      createConnection: () => raw,
      loadDirect: async () => fakeDirectModule(),
      createController: () => {
        created += 1;
        return fakeController();
      },
      pageResume: (listener) => {
        resume.push(listener);
        return () => undefined;
      },
    });
    await directLinkSettled(connection);
    expect(created).toBe(0);

    resume[0]?.();
    raw.becomeReady();
    await directLinkSettled(connection);
    expect(created).toBe(0);

    clearDirectLinkAvailability();
    raw.becomeReady();
    await directLinkSettled(connection);
    expect(created).toBe(1);

    resume[0]?.();
    raw.becomeReady();
    await directLinkSettled(connection);
    expect(created).toBe(1);
    connection.dispose();
    resetMeshNodesStateForTest();
  });

  test('DIRECT_UNAVAILABLE 停放：页面恢复 / READY 不起，用户显式 retryDirect 清掉负结论并显式重试', async () => {
    setMeshNodesStateForTest({ entryNodeId: 'entry-node', nodes: [] });
    markDirectLinkUnavailable('node-unavail', 'entry-node', Date.now(), 'direct-unavailable');
    const controller = fakeController();
    let created = 0;
    const resume: Array<() => void> = [];
    const raw = fakeConnection();
    const connection = createNodeConnection('node-unavail', {
      createConnection: () => raw,
      loadDirect: async () => fakeDirectModule(),
      createController: () => {
        created += 1;
        return controller;
      },
      pageResume: (listener) => {
        resume.push(listener);
        return () => undefined;
      },
    });
    await directLinkSettled(connection);
    resume[0]?.();
    raw.becomeReady();
    await directLinkSettled(connection);
    expect(created).toBe(0);

    connection.retryDirect();
    await directLinkSettled(connection);
    expect(created).toBe(1);
    expect(controller.explicitRetries).toBe(1);
    expect(controller.starts).toBe(0);
    expect(isDirectLinkUnavailable('node-unavail', 'entry-node')).toBe(false);
    connection.dispose();
    clearDirectLinkAvailability();
    resetMeshNodesStateForTest();
  });

  test('代答 401 的停放：显式 retryDirect 也不起（入口给不出直连，重试不会变）', async () => {
    setMeshNodesStateForTest({ entryNodeId: 'entry-node', nodes: [] });
    markDirectLinkUnavailable('node-foreign', 'entry-node');
    let created = 0;
    const connection = createNodeConnection('node-foreign', {
      createConnection: () => fakeConnection(),
      loadDirect: async () => fakeDirectModule(),
      createController: () => {
        created += 1;
        return fakeController();
      },
    });
    await directLinkSettled(connection);
    connection.retryDirect();
    await directLinkSettled(connection);
    expect(created).toBe(0);
    connection.dispose();
    clearDirectLinkAvailability();
    resetMeshNodesStateForTest();
  });

  test('负缓存停放后页面恢复同样能在过期后重起直连', async () => {
    setMeshNodesStateForTest({ entryNodeId: 'entry-node', nodes: [] });
    markDirectLinkUnavailable('node-parked-resume', 'entry-node');
    let created = 0;
    const resume: Array<() => void> = [];
    const connection = createNodeConnection('node-parked-resume', {
      createConnection: () => fakeConnection(),
      loadDirect: async () => fakeDirectModule(),
      createController: () => {
        created += 1;
        return fakeController();
      },
      pageResume: (listener) => {
        resume.push(listener);
        return () => undefined;
      },
    });
    await directLinkSettled(connection);
    clearDirectLinkAvailability();
    resume[0]?.();
    await directLinkSettled(connection);
    expect(created).toBe(1);
    connection.dispose();
    resetMeshNodesStateForTest();
  });

  test('入口身份还没落地时不查负缓存，直连照常协商一次', async () => {
    resetMeshNodesStateForTest();
    markDirectLinkUnavailable('node-b', null);
    let created = 0;
    const connection = createNodeConnection('node-b', {
      createConnection: () => fakeConnection(),
      loadDirect: async () => fakeDirectModule(),
      createController: () => {
        created += 1;
        return fakeController();
      },
    });
    await directLinkSettled(connection);

    expect(created).toBe(1);
    clearDirectLinkAvailability();
  });
});

describe('resume 钩子（切回 primary 的补齐）', () => {
  test('重发订阅 + 不主动重取整屏 + 提示最近输入可能未送达', () => {
    const calls: ResumeCalls = { mounts: [], releases: 0, screens: [], warnings: [] };
    const base = fakeConnection(['%1', '%2']);
    createNodeConnection('node-b', {
      createConnection: () => base,
      loadDirect: async () => fakeDirectModule(),
      createController: () => fakeController(),
      resolveRuntime: () => fakeRuntime(calls, { panes: ['%1', '%2', '%3'] }),
    });

    base.resumeHook?.();

    // 订阅重发一次（mount + 立即 release，集合不变但 generation 递增）
    expect(calls.mounts).toEqual([['device-a', '%1']]);
    expect(calls.releases).toBe(1);
    // canonical 重订阅自带 cursor，精确补流，不再整屏重取
    expect(calls.screens).toEqual([]);
    expect(calls.warnings).toEqual([DIRECT_FALLBACK_KEY]);
  });

  test('没有挂载中的 pane 时不重发订阅，但仍然提示', () => {
    const calls: ResumeCalls = { mounts: [], releases: 0, screens: [], warnings: [] };
    const base = fakeConnection();
    createNodeConnection('node-b', {
      createConnection: () => base,
      loadDirect: async () => fakeDirectModule(),
      createController: () => fakeController(),
      resolveRuntime: () => fakeRuntime(calls, { panes: ['%1'] }),
    });

    base.resumeHook?.();
    expect(calls.mounts).toEqual([]);
    expect(calls.screens).toEqual([]);
    expect(calls.warnings.length).toBe(1);
  });

  test('runtime 还没建好时只提示，不抛错', () => {
    const warnings: string[] = [];
    const base = fakeConnection();
    createNodeConnection('node-b', {
      createConnection: () => base,
      loadDirect: async () => fakeDirectModule(),
      createController: () => fakeController(),
      resolveRuntime: () => null,
      notifications: {
        info: () => {},
        success: () => {},
        error: () => {},
        warning: (title: string) => warnings.push(title),
      },
    });

    expect(() => base.resumeHook?.()).not.toThrow();
    expect(warnings).toEqual([DIRECT_FALLBACK_KEY]);
  });
});

// ---------------------------------------------------------------------------
// 4401 / QueryClient 回收：走**生产那份接线**（createAppNodeRuntimes），
// 只把底层 socket 换成假的。手动调 manager.notifyClose() 是掩盖接线缺失，这里一次都不调。
// ---------------------------------------------------------------------------

class FakeSocket implements WebSocketLike {
  readyState = 1;
  binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  sent: unknown[] = [];
  closed: number[] = [];

  constructor(readonly url: string) {}

  send(data: ArrayBufferLike | ArrayBufferView | string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.readyState = 3;
    this.closed.push(code ?? 1000);
  }
  /** 服务端主动关闭（会话失效 → 4401）。 */
  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  /** 走完 open + HELLO_S2C，把 ws-client 推到 READY。 */
  negotiate(): void {
    this.onopen?.();
    const payload = wsBorsh.encodePayload(wsBorsh.schema.HelloS2CSchema, {
      serverImpl: 'vibeterm-gateway',
      serverVersion: '2.1.0',
      selectedVersion: 1,
      maxFrameBytes: 1048576,
      heartbeatIntervalMs: 15000,
      capabilities: [],
    });
    const frame = wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_S2C, payload, 1);
    this.onmessage?.({
      data: frame.buffer.slice(
        frame.byteOffset,
        frame.byteOffset + frame.byteLength
      ) as ArrayBuffer,
    });
  }
}

function hostManager(options: {
  onUnauthorized?: (nodeId: string) => void;
  onDispose?: (nodeId: string) => void;
  sockets: FakeSocket[];
}) {
  return createAppNodeRuntimes(
    {
      ...(options.onUnauthorized ? { onUnauthorized: options.onUnauthorized } : {}),
      ...(options.onDispose ? { onDispose: options.onDispose } : {}),
      // 连接是被测对象，保持真实；runtime / apiClient 与本用例无关，换成替身。
      createApiClient: () => ({}) as never,
      createRuntime: () => ({ dispose: () => {} }) as unknown as AppRuntime,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
    },
    {
      socketFactory: (url: string) => {
        const socket = new FakeSocket(url);
        options.sockets.push(socket);
        return socket;
      },
      // 直连控制器与 4401 无关，且会去开真 RTCPeerConnection。
      loadDirect: async () => null,
      createController: () => null,
    }
  );
}

const NODE_HEX_A = 'a'.repeat(32);
const NODE_HEX_B = 'b'.repeat(32);
const NODE_HEX_C = 'c'.repeat(32);

describe('4401 通过真实宿主接线传到 manager', () => {
  test('真 ws-client 连接被 4401 关闭 → 派发该 node 的鉴权事件并停连接', () => {
    const sockets: FakeSocket[] = [];
    const unauthorized: string[] = [];
    const manager = hostManager({ sockets, onUnauthorized: (id) => unauthorized.push(id) });

    const entry = manager.get(NODE_HEX_A);
    entry.connection.client.connect();
    expect(sockets.length).toBe(1);

    sockets[0].serverClose(4401);

    expect(unauthorized).toEqual([NODE_HEX_A]);
    manager.disposeAll();
  });

  test('普通关闭码不派发鉴权事件（否则每次断线都跳登录）', () => {
    const sockets: FakeSocket[] = [];
    const unauthorized: string[] = [];
    const manager = hostManager({ sockets, onUnauthorized: (id) => unauthorized.push(id) });

    const entry = manager.get(NODE_HEX_B);
    entry.connection.client.connect();
    sockets[0].serverClose(1006);

    expect(unauthorized).toEqual([]);
    manager.disposeAll();
  });

  test('self 的 4401 同样经真实连接传回来', () => {
    const sockets: FakeSocket[] = [];
    const unauthorized: string[] = [];
    const manager = hostManager({ sockets, onUnauthorized: (id) => unauthorized.push(id) });

    const entry = manager.get('self');
    entry.connection.client.connect();
    sockets[0].serverClose(4401);

    expect(unauthorized).toEqual(['self']);
    manager.disposeAll();
  });
});

describe('Gateway WS 的 client nonce（F3-5）', () => {
  /** URL 上的 `?cid=`；没有就是 null（node 在多标签下就答不出 connectionId）。 */
  function cidOf(url: string): string | null {
    return /[?&]cid=([^&]+)/.exec(url)?.[1] ?? null;
  }

  test('生产接线建出的 socket URL 带 `?cid=`，重连换新 nonce，跨 node 不重复', () => {
    const sockets: FakeSocket[] = [];
    const manager = hostManager({ sockets });

    manager.get(NODE_HEX_A).connection.client.connect();
    manager.get(NODE_HEX_A).connection.client.reconnect();
    manager.get(NODE_HEX_B).connection.client.connect();

    expect(sockets.length).toBe(3);
    expect(sockets[0].url).toContain(`/n/${NODE_HEX_A}/ws?cid=`);
    expect(sockets[2].url).toContain(`/n/${NODE_HEX_B}/ws?cid=`);
    const cids = sockets.map((socket) => cidOf(socket.url));
    for (const cid of cids) expect(cid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(new Set(cids).size).toBe(3);

    manager.disposeAll();
  });

  test('控制器拿到的 cid 就是当前 socket 那一个，随重连一起换', async () => {
    const sockets: FakeSocket[] = [];
    const captured: Array<() => string | null> = [];
    const connection = createNodeConnection(NODE_HEX_C, {
      socketFactory: (url: string) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      loadDirect: async () => fakeDirectModule(),
      createController: (_nodeId, _connection, getCid) => {
        captured.push(getCid);
        return fakeController();
      },
    });
    // 直连接线等 WS 就绪：还没连上时控制器根本不该被建出来（否则 `?cid=` 必然是 null）。
    await directLinkSettled(connection);
    expect(captured).toEqual([]);

    connection.client.connect();
    sockets[0].negotiate();
    await directLinkSettled(connection);
    const cid = captured[0];
    expect(cid).toBeDefined();

    const first = cid?.();
    expect(first).toBe(cidOf(sockets[0].url));

    connection.client.reconnect();
    expect(cid?.()).toBe(cidOf(sockets[1].url));
    expect(cid?.()).not.toBe(first);

    connection.dispose();
  });
});

describe('侧栏折叠 / 路由离开后的宽限释放', () => {
  const NODE_HEX_D = 'd'.repeat(32);

  test('引用归零后要等宽限期到点才回收：来回折叠不会重新拨号', () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<{ fn: () => void; cancelled: boolean }> = [];
    const disposed: string[] = [];
    const manager = createAppNodeRuntimes(
      {
        onDispose: (id) => disposed.push(id),
        createApiClient: () => ({}) as never,
        createRuntime: () => ({ dispose: () => {} }) as unknown as AppRuntime,
        setTimeoutFn: (fn) => {
          timers.push({ fn, cancelled: false });
          return timers.length - 1;
        },
        clearTimeoutFn: (handle) => {
          const timer = timers[handle as number];
          if (timer) timer.cancelled = true;
        },
      },
      {
        socketFactory: (url: string) => {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
        loadDirect: async () => null,
        createController: () => null,
      }
    );

    // 分节展开 → 建连接
    const entry = manager.acquire(NODE_HEX_D);
    entry.connection.client.connect();
    expect(sockets.length).toBe(1);

    // 折叠：引用归零，但宽限期内不回收
    manager.release(NODE_HEX_D);
    expect(manager.has(NODE_HEX_D)).toBe(true);
    expect(disposed).toEqual([]);

    // 立刻又展开：拿回的是同一条连接，没有第二次拨号
    expect(manager.acquire(NODE_HEX_D).connection).toBe(entry.connection);
    expect(sockets.length).toBe(1);

    // 再折叠并让宽限期到点：这次真回收
    manager.release(NODE_HEX_D);
    const pending = timers.filter((timer) => !timer.cancelled);
    expect(pending.length).toBe(1);
    pending[0].fn();

    expect(manager.has(NODE_HEX_D)).toBe(false);
    expect(disposed).toEqual([NODE_HEX_D]);
    manager.disposeAll();
  });
});

describe('QueryClient 随 runtime 一起回收', () => {
  test('生产接线里 dispose 会释放该 node 的 QueryClient', () => {
    const sockets: FakeSocket[] = [];
    const manager = hostManager({ sockets });

    manager.get(NODE_HEX_C);
    const before = nodeQueryClient(NODE_HEX_C);
    before.setQueryData(['probe'], 1);

    manager.dispose(NODE_HEX_C);

    // 释放过了：再取是一个全新的 client，旧缓存不会跟着复活。
    const after = nodeQueryClient(NODE_HEX_C);
    expect(after).not.toBe(before);
    expect(after.getQueryData(['probe'])).toBeUndefined();
    manager.disposeAll();
  });
});

describe('每 node 的 QueryClient：设备列表的过期时间与首帧占位', () => {
  const DEVICE: Device = {
    id: 'd1',
    name: '书房',
    type: 'local',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  test("['devices'] 过期时间放宽到 60 秒：切回前台不再给每个挂载中的 node 各来一条 /api/devices", () => {
    expect(DEVICES_STALE_MS).toBe(60_000);
    const defaults = nodeQueryClient(NODE_HEX_C).getQueryDefaults(devicesQueryKey);
    expect(defaults.staleTime).toBe(DEVICES_STALE_MS);
    // 其余查询不受影响，仍是 5 秒
    expect(nodeQueryClient(NODE_HEX_C).getDefaultOptions().queries?.staleTime).toBe(5000);
    disposeNodeQueryClient(NODE_HEX_C);
  });

  test('回前台只补设备列表：其余查询的 refetchOnWindowFocus 一律关掉', () => {
    const client = nodeQueryClient(NODE_HEX_C);
    expect(client.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
    expect(client.getQueryDefaults(devicesQueryKey).refetchOnWindowFocus).toBe(true);
    disposeNodeQueryClient(NODE_HEX_C);
  });

  test('首帧占位挂在客户端缺省上：没显式传 placeholderData 的观察者也拿得到本 node 的快照', () => {
    const restore = installWindowStorage();
    try {
      localStorage.clear();
      writeDeviceSnapshot(NODE_HEX_C, [DEVICE]);
      const resolve = nodeQueryClient(NODE_HEX_C).getQueryDefaults(devicesQueryKey)
        .placeholderData as () => { devices: { id: string }[] } | undefined;
      expect(resolve()?.devices.map((device) => device.id)).toEqual(['d1']);

      // 快照按 node 分键：别的 node 的客户端拿不到这一份
      const other = nodeQueryClient(NODE_HEX_D_PLACEHOLDER).getQueryDefaults(devicesQueryKey)
        .placeholderData as () => unknown;
      expect(other()).toBeUndefined();
      disposeNodeQueryClient(NODE_HEX_D_PLACEHOLDER);
    } finally {
      disposeNodeQueryClient(NODE_HEX_C);
      restore();
    }
  });
});

const NODE_HEX_D_PLACEHOLDER = 'e'.repeat(32);

// ---------------------------------------------------------------------------
// nodeId → 展示名：包内提示语（如「终端连接失败：节点 xxx 版本过低」）只有编号，
// 宿主要把节点目录的查名函数接进每个 runtime。
// ---------------------------------------------------------------------------

describe('createAppNodeRuntimes：把 mesh 节点目录的查名函数接进 runtime', () => {
  function meshNode(id: string, name: string): MeshNode {
    return {
      id,
      name,
      publicKey: '',
      online: true,
      reach: 'lan',
      version: null,
      direct_capable: false,
      inventory: null,
      loggedIn: false,
    } as MeshNode;
  }

  test('注入的 resolveNodeName 每次现查 store，self 按 entry 自身解析', () => {
    let injected: AppRuntimeOptions | null = null;
    const manager = createAppNodeRuntimes({
      createConnection: () => fakeConnection(),
      createApiClient: () => ({}) as never,
      createRuntime: (options) => {
        injected = options;
        return { dispose: () => {} } as unknown as AppRuntime;
      },
    });

    manager.get(NODE_HEX_C);
    const resolve = (injected as AppRuntimeOptions | null)?.resolveNodeName;
    expect(typeof resolve).toBe('function');

    // 建 runtime 那一刻列表还没拉到：查不到就返回 null，由包内退回编号前缀。
    resetMeshNodesStateForTest();
    expect(resolve?.(NODE_HEX_C)).toBeNull();

    setMeshNodesStateForTest({
      entryNodeId: 'entry-node',
      nodes: [meshNode(NODE_HEX_C, 'jiefa-app'), meshNode('entry-node', 'entry-box')],
    });
    expect(resolve?.(NODE_HEX_C)).toBe('jiefa-app');
    expect(resolve?.('self')).toBe('entry-box');
    expect(resolve?.('e'.repeat(32))).toBeNull();

    resetMeshNodesStateForTest();
    manager.disposeAll();
  });
});

// 4401 判定终局之后，用户点「登录此节点」（或门闸静默登录成功）就该立刻把连接拉起来。
describe('hasLoginRecovery', () => {
  const NODE = 'a'.repeat(32);

  test('未登录 → 已登录才算恢复', () => {
    const seen = new Map([[NODE, false]]);
    expect(hasLoginRecovery(seen, [{ id: NODE, loggedIn: true }])).toBe(true);
    expect(hasLoginRecovery(seen, [{ id: NODE, loggedIn: false }])).toBe(false);
  });

  test('一直是已登录、或第一次见到这台 node，都不算恢复', () => {
    expect(hasLoginRecovery(new Map([[NODE, true]]), [{ id: NODE, loggedIn: true }])).toBe(false);
    expect(hasLoginRecovery(new Map(), [{ id: NODE, loggedIn: true }])).toBe(false);
  });
});

// 包内的重试按钮按下时调 `runtime.releaseRequestBackoff()`：宿主据此解除这台 node 的
// 不可达退避，那一发 refetch 才出得去（`invalidateQueries` 靠不住——已经出错的查询
// `isInvalidated` 本来就是 true，再 invalidate 一次连事件都不派）。
describe('runtime.releaseRequestBackoff', () => {
  const NODE = 'b'.repeat(32);

  test('宿主接线把它接到该 node 的退避解除上', () => {
    setNodeBackoffTimersForTest({ schedule: () => 1, cancel: () => undefined, now: () => 0 });
    let injected: AppRuntimeOptions | null = null;
    const manager = createAppNodeRuntimes({
      createConnection: () => fakeConnection(),
      createApiClient: () => ({}) as never,
      createRuntime: (options) => {
        injected = options;
        return { dispose: () => {} } as unknown as AppRuntime;
      },
    });
    manager.get(NODE);

    noteNodeUnreachable(NODE);
    expect(isNodeRequestBlocked(NODE)).toBe(true);
    (injected as AppRuntimeOptions | null)?.releaseRequestBackoff?.();
    expect(isNodeRequestBlocked(NODE)).toBe(false);

    manager.disposeAll();
    setNodeBackoffTimersForTest(null);
  });

  test('解除的只是它自己那一台', () => {
    setNodeBackoffTimersForTest({ schedule: () => 1, cancel: () => undefined, now: () => 0 });
    const other = 'c'.repeat(32);
    let injected: AppRuntimeOptions | null = null;
    const manager = createAppNodeRuntimes({
      createConnection: () => fakeConnection(),
      createApiClient: () => ({}) as never,
      createRuntime: (options) => {
        injected = options;
        return { dispose: () => {} } as unknown as AppRuntime;
      },
    });
    manager.get(NODE);

    noteNodeUnreachable(NODE);
    noteNodeUnreachable(other);
    (injected as AppRuntimeOptions | null)?.releaseRequestBackoff?.();
    expect(isNodeRequestBlocked(other)).toBe(true);

    manager.disposeAll();
    setNodeBackoffTimersForTest(null);
  });
});

// 端到端：查询已经出错（退避记上了）→ 面板的重试按钮走 `retryNodeQuery` → 门让路，请求出得去。
describe('重试按钮掀开退避门（端到端）', () => {
  const NODE = 'd'.repeat(32);
  const originalFetch = globalThis.fetch;

  test('出错后的自动回源被门驳回，重试则真的发出去', async () => {
    setNodeBackoffTimersForTest({ schedule: () => 1, cancel: () => undefined, now: () => 0 });
    const urls: string[] = [];
    globalThis.fetch = ((input: string | URL | Request) => {
      urls.push(String(input));
      return Promise.resolve(new Response(JSON.stringify({ devices: [] }), { status: 200 }));
    }) as unknown as typeof fetch;

    let injected: AppRuntimeOptions | null = null;
    const manager = createAppNodeRuntimes({
      createConnection: () => fakeConnection(),
      createRuntime: (options) => {
        injected = options;
        return { dispose: () => {} } as unknown as AppRuntime;
      },
    });
    const entry = manager.get(NODE);

    // 这台 node 刚被判打不通（设备列表那条查询记的账）。
    noteNodeUnreachable(NODE);
    await expect(entry.apiClient.fetch('/api/devices')).rejects.toBeInstanceOf(Error);
    expect(urls).toHaveLength(0);

    // 用户点重试：先解除退避，再回源。
    let refetched = 0;
    retryNodeQuery(injected as unknown as AppRuntimeOptions, () => {
      refetched += 1;
      return entry.apiClient.fetch('/api/devices');
    });
    expect(refetched).toBe(1);
    expect(urls).toEqual([`/n/${NODE}/api/devices`]);
    expect(isNodeRequestBlocked(NODE)).toBe(false);

    manager.disposeAll();
    globalThis.fetch = originalFetch;
    setNodeBackoffTimersForTest(null);
  });
});
