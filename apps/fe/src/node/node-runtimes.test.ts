// 直连控制器的接线：非 self 的 node 才起控制器，诊断源与 bulk 客户端挂到连接上，
// 切回 primary 时补齐已订阅 pane，dispose 时一并停掉。

import { describe, expect, test } from 'bun:test';
import type { AppRuntime } from '@tmex/stores';
import {
  type DirectCarrierController,
  type GatewayConnection,
  getBulkClient,
} from '@tmex/ws-client';
import { createNodeConnection } from './node-runtimes';

interface FakeConnection extends GatewayConnection {
  resumeHook: (() => void) | null;
  mountedPanes: Set<string>;
}

function fakeConnection(mountedPanes: string[] = []): FakeConnection {
  const mounted = new Set(mountedPanes);
  const connection = {
    client: {} as GatewayConnection['client'],
    transport: {} as GatewayConnection['transport'],
    paneSinks: {
      hasPaneSink: (_deviceId: string, paneId: string) => mounted.has(paneId),
    } as unknown as GatewayConnection['paneSinks'],
    selectMachine: {} as GatewayConnection['selectMachine'],
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
  diagnosticsSource: { get: () => unknown; subscribe: () => () => void };
}

function fakeController(): FakeController & DirectCarrierController {
  const controller = {
    starts: 0,
    stops: 0,
    diagnosticsSource: {
      get: () => ({ path: 'primary', route: null, rtt: null, ice: null }),
      subscribe: () => () => {},
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
  test('self 不建直连控制器，也不挂诊断源', () => {
    let created = 0;
    const connection = createNodeConnection('self', {
      createConnection: () => fakeConnection(),
      createController: () => {
        created += 1;
        return null;
      },
    });

    expect(created).toBe(0);
    expect(connection.directDiagnostics).toBeNull();
  });

  test('undefined / 空串按 self 处理，同样不建控制器', () => {
    let created = 0;
    const wiring = {
      createConnection: () => fakeConnection(),
      createController: () => {
        created += 1;
        return null;
      },
    };
    createNodeConnection('', wiring);
    expect(created).toBe(0);
  });

  test('非 self 的 node 建控制器、start() 并把诊断源挂到 connection 上', () => {
    const controller = fakeController();
    const nodeIds: string[] = [];
    const connection = createNodeConnection('node-b', {
      createConnection: () => fakeConnection(),
      createController: (nodeId) => {
        nodeIds.push(nodeId);
        return controller;
      },
    });

    expect(nodeIds).toEqual(['node-b']);
    expect(controller.starts).toBe(1);
    expect(connection.directDiagnostics).toBe(controller.diagnosticsSource);
  });

  test('按 nodeId 登记 BulkClient，dispose 时注销', () => {
    const controller = fakeController();
    const connection = createNodeConnection('node-bulk', {
      createConnection: () => fakeConnection(),
      createController: () => controller,
    });

    expect(getBulkClient('node-bulk')).not.toBeNull();
    connection.dispose();
    expect(getBulkClient('node-bulk')).toBeNull();
  });

  test('dispose() 先停控制器再走原始 dispose，并摘掉 resume 钩子', () => {
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
      createController: () => controller,
    });
    expect(base.resumeHook).not.toBeNull();
    connection.dispose();

    expect(order).toEqual(['controller', 'connection']);
    expect(controller.stops).toBe(1);
    expect(base.resumeHook).toBeNull();
  });

  test('控制器工厂返回 null（直连不可用）时连接照常可用', () => {
    const connection = createNodeConnection('node-b', {
      createConnection: () => fakeConnection(),
      createController: () => null,
    });
    expect(connection.directDiagnostics).toBeNull();
  });
});

describe('resume 钩子（切回 primary 的补齐）', () => {
  test('重发订阅 + 对挂载中的 pane 重取整屏 + 提示最近输入可能未送达', () => {
    const calls: ResumeCalls = { mounts: [], releases: 0, screens: [], warnings: [] };
    const base = fakeConnection(['%1', '%2']);
    createNodeConnection('node-b', {
      createConnection: () => base,
      createController: () => fakeController(),
      resolveRuntime: () => fakeRuntime(calls, { panes: ['%1', '%2', '%3'] }),
    });

    base.resumeHook?.();

    // 订阅重发一次（mount + 立即 release，集合不变但 generation 递增）
    expect(calls.mounts).toEqual([['device-a', '%1']]);
    expect(calls.releases).toBe(1);
    // 只对挂载中的 pane 重取画面，%3 没挂载不请求
    expect(calls.screens).toEqual([
      ['device-a', '%1'],
      ['device-a', '%2'],
    ]);
    expect(calls.warnings).toEqual(['直连已断开，最近输入可能未送达']);
  });

  test('没有挂载中的 pane 时不重发订阅，但仍然提示', () => {
    const calls: ResumeCalls = { mounts: [], releases: 0, screens: [], warnings: [] };
    const base = fakeConnection();
    createNodeConnection('node-b', {
      createConnection: () => base,
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
    expect(warnings).toEqual(['直连已断开，最近输入可能未送达']);
  });
});
