import { describe, expect, test } from 'bun:test';
import { BorshWebSocketClient, defaultWsUrl } from './client';
import { createGatewayConnection } from './connection';
import type { PaneSink } from './pane-sink-registry';
import { createSharedGatewayTransport } from './transport';

function collectingSink(outputs: Uint8Array[]): PaneSink {
  return {
    onReset() {},
    onApplyHistory() {},
    onOutput(data) {
      outputs.push(data);
    },
  };
}

describe('createGatewayConnection', () => {
  test('每个连接持有独立的 pane-sink 注册表', async () => {
    const a = createGatewayConnection({ wsUrl: 'ws://a.example/ws' });
    const b = createGatewayConnection({ wsUrl: 'ws://b.example/ws' });

    const receivedA: Uint8Array[] = [];
    a.paneSinks.registerPaneSink('dev', 'pane', collectingSink(receivedA));

    b.paneSinks.dispatchPaneOutput('dev', 'pane', new Uint8Array([1]));
    // 输出在微任务边界合并下发
    await Promise.resolve();
    expect(receivedA.length).toBe(0);

    a.paneSinks.dispatchPaneOutput('dev', 'pane', new Uint8Array([2]));
    await Promise.resolve();
    expect(receivedA.length).toBe(1);

    a.dispose();
    b.dispose();
  });

  test('wsUrl 注入到 client，dispose 后连接关闭', () => {
    const conn = createGatewayConnection({ wsUrl: 'ws://example.test/ws' });
    expect(conn.client.getUrl()).toBe('ws://example.test/ws');
    conn.dispose();
    expect(conn.client.getState()).toBe('CLOSED');
  });

  test('独立 selectMachine，互不共享事务状态', () => {
    const a = createGatewayConnection();
    const b = createGatewayConnection();
    expect(a.selectMachine).not.toBe(b.selectMachine);
    a.dispose();
    b.dispose();
  });

  test('dispose does not close a host-owned shared transport', () => {
    let disconnects = 0;
    const transport = createSharedGatewayTransport({
      initialState: 'READY',
      onDisconnect: () => {
        disconnects += 1;
      },
      onCommand: () => {},
    });
    const connection = createGatewayConnection({ transport });

    connection.dispose();

    expect(disconnects).toBe(0);
    expect(transport.isReady()).toBe(true);
    expect(transport.send({ type: 'connect-device', deviceId: 'device-a' })).toBe(true);
    transport.dispose();
  });
});

describe('BorshWebSocketClient url 注入', () => {
  test('缺省走 defaultWsUrl，updateUrl 切换端点', () => {
    const client = new BorshWebSocketClient();
    expect(client.getUrl()).toBe(defaultWsUrl());

    client.updateUrl('ws://other.example/ws');
    expect(client.getUrl()).toBe('ws://other.example/ws');
  });

  test('构造注入 url 优先于默认推导', () => {
    const client = new BorshWebSocketClient({ url: 'ws://injected.example/ws' });
    expect(client.getUrl()).toBe('ws://injected.example/ws');
  });
});
