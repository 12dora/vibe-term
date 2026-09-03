// 直连控制器的接线：非 self 的 node 才起控制器，诊断源与 bulk 客户端挂到连接上，
// 切回 primary 时补齐已订阅 pane，dispose 时一并停掉。

import { describe, expect, test } from 'bun:test';
import type { AppRuntime } from '@tmex/stores';
import type { GatewayConnection, WebSocketLike } from '@tmex/ws-client';
import type { DirectCarrierController } from '@tmex/ws-client/direct';
import { getBulkClient } from '@tmex/ws-client/direct/bulk-client';
import type { DirectDiagnostics } from '@tmex/ws-client/direct/types';
import { PRIMARY_ONLY_DIAGNOSTICS, resolveDirectDiagnostics } from '@tmex/ws-client/direct/types';
import {
  type DirectLinkModule,
  createAppNodeRuntimes,
  createNodeConnection,
  directLinkSettled,
  nodeQueryClient,
} from './node-runtimes';

/** 直连断开提示的 i18n key：locale 里已有正式条目，测试里的假 `t` 原样返回 key。 */
const DIRECT_FALLBACK_KEY = 'device.directFallbackToast';

interface FakeConnection extends GatewayConnection {
  resumeHook: (() => void) | null;
  mountedPanes: Set<string>;
}

function fakeConnection(mountedPanes: string[] = []): FakeConnection {
  const mounted = new Set(mountedPanes);
  const connection = {
    client: {} as GatewayConnection['client'],
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
    dispose: () => {},
    resumeHook: null as (() => void) | null,
    mountedPanes: mounted,
  };
  return connection as unknown as FakeConnection;
}

interface FakeController {
  starts: number;
  stops: number;
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
    getState: () => 'idle',
    createDataChannel: () => {
      throw new Error('direct carrier not active');
    },
    start() {
      controller.starts += 1;
    },
    stop() {
      controller.stops += 1;
    },
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
    await directLinkSettled(connection);
    const cid = captured[0];
    expect(cid).toBeDefined();

    // 还没建 socket：没有 nonce，控制器只能退化成不带 cid 的查询
    expect(cid?.()).toBeNull();

    connection.client.connect();
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
