// 直连控制器的接线：非 self 的 node 才起控制器，诊断源挂到连接上，dispose 时一并停掉。

import { describe, expect, test } from 'bun:test';
import type { DirectCarrierController, GatewayConnection } from '@tmex/ws-client';
import { createNodeConnection } from './node-runtimes';

function fakeConnection(): GatewayConnection {
  return {
    client: {} as GatewayConnection['client'],
    transport: {} as GatewayConnection['transport'],
    paneSinks: {} as GatewayConnection['paneSinks'],
    selectMachine: {} as GatewayConnection['selectMachine'],
    directDiagnostics: null,
    attachDirectCarrier: () => {},
    detachDirectCarrier: () => {},
    activeCarrier: 'primary',
    onCarrierChange: () => () => {},
    dispose: () => {},
  };
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
      get: () => ({ path: 'primary', rtt: null, ice: null }),
      subscribe: () => () => {},
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

  test('dispose() 先停控制器再走原始 dispose', () => {
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
    connection.dispose();

    expect(order).toEqual(['controller', 'connection']);
    expect(controller.stops).toBe(1);
  });

  test('控制器工厂返回 null（直连不可用）时连接照常可用', () => {
    const connection = createNodeConnection('node-b', {
      createConnection: () => fakeConnection(),
      createController: () => null,
    });
    expect(connection.directDiagnostics).toBeNull();
  });
});
