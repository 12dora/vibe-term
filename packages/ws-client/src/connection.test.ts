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

describe('onClose 关闭码回调', () => {
  function fakeSocket() {
    return {
      readyState: 0,
      binaryType: 'arraybuffer' as const,
      onopen: null as ((event?: unknown) => void) | null,
      onmessage: null as ((event: { data: ArrayBuffer | string }) => void) | null,
      onclose: null as ((event?: unknown) => void) | null,
      onerror: null as ((event?: unknown) => void) | null,
      send() {},
      close() {},
    };
  }

  test('把 CloseEvent.code 透给宿主，并且不影响 client 自己的收敛', () => {
    const codes: number[] = [];
    let socket: ReturnType<typeof fakeSocket> | null = null;
    const conn = createGatewayConnection({
      wsUrl: 'ws://x/ws',
      socketFactory: () => {
        socket = fakeSocket();
        return socket;
      },
      onClose: (code) => codes.push(code),
    });
    conn.client.connect();
    expect(socket).not.toBeNull();
    // client 装的是自己的 onclose；shim 会先调 onClose(code) 再转给它。
    (socket as unknown as { onclose: (event: unknown) => void }).onclose({ code: 4401 });
    expect(codes).toEqual([4401]);
    expect(conn.client.getState()).not.toBe('READY');
    conn.dispose();
  });

  test('取不到 code 时按 1006 上报', () => {
    const codes: number[] = [];
    let socket: ReturnType<typeof fakeSocket> | null = null;
    const conn = createGatewayConnection({
      wsUrl: 'ws://x/ws',
      socketFactory: () => {
        socket = fakeSocket();
        return socket;
      },
      onClose: (code) => codes.push(code),
    });
    conn.client.connect();
    (socket as unknown as { onclose: (event: unknown) => void }).onclose({});
    expect(codes).toEqual([1006]);
    conn.dispose();
  });

  test('不传 onClose 时 socketFactory 原样透传（零改动路径）', () => {
    let created = 0;
    const conn = createGatewayConnection({
      wsUrl: 'ws://x/ws',
      socketFactory: () => {
        created += 1;
        return fakeSocket();
      },
    });
    conn.client.connect();
    expect(created).toBe(1);
    conn.dispose();
  });

  describe('wsUrlFactory（每条 socket 一个新 URL）', () => {
    test('建 socket 时现算 URL，重连再算一次；getUrl 仍是静态 wsUrl', () => {
      const urls: string[] = [];
      let n = 0;
      const conn = createGatewayConnection({
        wsUrl: 'ws://x/ws',
        wsUrlFactory: () => `ws://x/ws?cid=n${++n}`,
        socketFactory: (url) => {
          urls.push(url);
          return fakeSocket();
        },
      });

      conn.client.connect();
      // 断线后重连：客户端复用 options.url，nonce 只能靠这一层轮换
      conn.client.reconnect();
      expect(urls).toEqual(['ws://x/ws?cid=n1', 'ws://x/ws?cid=n2']);
      expect(conn.client.getUrl()).toBe('ws://x/ws');
      conn.dispose();
    });

    test('与 onClose 并用时两层包装都生效', () => {
      const urls: string[] = [];
      const codes: number[] = [];
      let socket: ReturnType<typeof fakeSocket> | null = null;
      const conn = createGatewayConnection({
        wsUrl: 'ws://x/ws',
        wsUrlFactory: () => 'ws://x/ws?cid=abc',
        socketFactory: (url) => {
          urls.push(url);
          socket = fakeSocket();
          return socket;
        },
        onClose: (code) => codes.push(code),
      });

      conn.client.connect();
      expect(urls).toEqual(['ws://x/ws?cid=abc']);
      (socket as unknown as { onclose: (event: unknown) => void }).onclose({ code: 4401 });
      expect(codes).toEqual([4401]);
      conn.dispose();
    });
  });
});
