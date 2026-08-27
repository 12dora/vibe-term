import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { nodeWsUrl } from '@tmex/api-client';
import {
  type GatewayConnection,
  type WebSocketLike,
  createGatewayConnection,
} from '@tmex/ws-client';
import {
  NodeConnectionManager,
  WS_UNAUTHORIZED_CLOSE_CODE,
  createDefaultNodeConnection,
  nodeStoragePrefix,
} from './node-connection-manager';
import { installWindowStorage } from './test-utils';

installWindowStorage();

const NODE_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
const NODE_B = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';

interface FakeClock {
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  advance: (ms: number) => void;
  pending: () => number;
}

function createFakeClock(): FakeClock {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    schedule(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    cancel(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    pending() {
      return timers.size;
    },
  };
}

// 不建真实 socket：ws-client 的构造函数不发起连接，socketFactory 也不会被调用。
function makeConnection(): GatewayConnection {
  return createGatewayConnection({
    wsUrl: 'ws://localhost/ws',
    socketFactory: () => {
      throw new Error('should not connect in tests');
    },
  });
}

function createManager(clock: FakeClock, extra: Record<string, unknown> = {}) {
  return new NodeConnectionManager({
    graceMs: 30_000,
    createConnection: () => makeConnection(),
    setTimeoutFn: clock.schedule,
    clearTimeoutFn: clock.cancel,
    ...extra,
  });
}

let clock: FakeClock;

beforeEach(() => {
  clock = createFakeClock();
});

describe('nodeStoragePrefix', () => {
  test('self 沿用旧 key，其余按 node 隔离', () => {
    expect(nodeStoragePrefix('self')).toBe('');
    expect(nodeStoragePrefix('')).toBe('');
    expect(nodeStoragePrefix(NODE_A)).toBe(`n:${NODE_A}:`);
  });
});

describe('NodeConnectionManager.get', () => {
  test('同一 nodeId 复用同一份运行时', () => {
    const manager = createManager(clock);
    expect(manager.get('self')).toBe(manager.get('self'));
    expect(manager.get(NODE_A)).toBe(manager.get(NODE_A));
    manager.disposeAll();
  });

  test('空 / undefined nodeId 归一为 self', () => {
    const manager = createManager(clock);
    expect(manager.get('')).toBe(manager.get('self'));
    expect(manager.list()).toHaveLength(1);
    manager.disposeAll();
  });

  test('不同 node 之间连接、ApiClient、store 与 storage 前缀相互隔离', () => {
    const manager = createManager(clock);
    const a = manager.acquire(NODE_A);
    const b = manager.acquire(NODE_B);

    expect(a.runtime).not.toBe(b.runtime);
    expect(a.connection).not.toBe(b.connection);
    expect(a.apiClient.baseUrl).toBe(`/n/${NODE_A}`);
    expect(b.apiClient.baseUrl).toBe(`/n/${NODE_B}`);
    expect(a.runtime.storagePrefix).toBe(`n:${NODE_A}:`);
    expect(b.runtime.storagePrefix).toBe(`n:${NODE_B}:`);
    expect(a.runtime.stores.tmux).not.toBe(b.runtime.stores.tmux);
    expect(a.runtime.stores.agent).not.toBe(b.runtime.stores.agent);
    // UI 偏好是宿主级的，所有 node 共用一份（key 仍为 tmex-ui）
    expect(a.runtime.stores.ui).toBe(b.runtime.stores.ui);
    manager.disposeAll();
  });

  test('self 的 ApiClient 与 storage key 与单 node 时逐字节一致', () => {
    const manager = createManager(clock);
    const self = manager.get('self');
    expect(self.apiClient.baseUrl).toBe('');
    expect(self.apiClient.url('/api/devices')).toBe('/api/devices');
    expect(self.runtime.storagePrefix).toBe('');
    manager.disposeAll();
  });

  test('host.appPath 给包内构造的应用内路径加 node 前缀', () => {
    const manager = createManager(clock);
    const self = manager.get('self');
    const a = manager.get(NODE_A);
    expect(self.runtime.host.appPath?.('/devices/d1') ?? '/devices/d1').toBe('/devices/d1');
    expect(a.runtime.host.appPath?.('/devices/d1')).toBe(`/n/${NODE_A}/devices/d1`);
    manager.disposeAll();
  });

  test('默认 WS 地址按 node 解析', () => {
    expect(nodeWsUrl('self', { protocol: 'https:', host: 'h' })).toBe('wss://h/ws');
    expect(nodeWsUrl(NODE_A, { protocol: 'https:', host: 'h' })).toBe(`wss://h/n/${NODE_A}/ws`);
  });
});

describe('createDefaultNodeConnection 的 client nonce（F3-5）', () => {
  // 这里要真的 connect() 才看得到 socket URL，而 client.connect() 会挂 visibilitychange；
  // 别的测试文件留下的 document 桩没有 addEventListener，本 describe 期间自备一份完整的。
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

  beforeAll(() => {
    Object.defineProperty(globalThis, 'document', {
      value: {
        visibilityState: 'visible',
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      configurable: true,
      writable: true,
    });
  });

  afterAll(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });

  function fakeSocket(): WebSocketLike {
    return {
      readyState: 0,
      binaryType: 'arraybuffer',
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send() {},
      close() {},
    };
  }

  /** URL 上的 `?cid=`；没有就是 null（那样 node 在多标签下答不出 connectionId）。 */
  function cidOf(url: string): string | null {
    return /[?&]cid=([^&]+)/.exec(url)?.[1] ?? null;
  }

  function connectCapturing(nodeId: string): { urls: string[]; connection: GatewayConnection } {
    const urls: string[] = [];
    const connection = createDefaultNodeConnection(
      nodeId,
      () => {},
      (url) => {
        urls.push(url);
        return fakeSocket();
      }
    );
    return { urls, connection };
  }

  test('WS URL 带 `?cid=`，重连换新 nonce', () => {
    const { urls, connection } = connectCapturing(NODE_A);
    connection.client.connect();
    connection.client.reconnect();

    expect(urls.length).toBe(2);
    for (const url of urls) {
      expect(url).toContain(`/n/${NODE_A}/ws?cid=`);
      expect(cidOf(url)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
    // 一条 WS 一个 nonce：重连是另一条 WS，服务端会另发一个 connectionId
    expect(cidOf(urls[0] as string)).not.toBe(cidOf(urls[1] as string));
    connection.dispose();
  });

  test('不同 node 的连接 nonce 互不相同', () => {
    const a = connectCapturing(NODE_A);
    const b = connectCapturing(NODE_B);
    a.connection.client.connect();
    b.connection.client.connect();

    expect(cidOf(a.urls[0] as string)).not.toBe(cidOf(b.urls[0] as string));
    a.connection.dispose();
    b.connection.dispose();
  });
});

describe('NodeConnectionManager acquire / release / 宽限期', () => {
  test('release 归零后宽限期结束才 dispose', () => {
    const disposeRuntime = mock(() => {});
    const disposeConnection = mock(() => {});
    const manager = createManager(clock, {
      createConnection: () => {
        const connection = makeConnection();
        return { ...connection, dispose: disposeConnection };
      },
      createRuntime: () => ({ dispose: disposeRuntime }) as never,
    });

    manager.acquire(NODE_A);
    manager.release(NODE_A);
    expect(manager.has(NODE_A)).toBe(true);

    clock.advance(29_000);
    expect(manager.has(NODE_A)).toBe(true);
    expect(disposeRuntime).not.toHaveBeenCalled();

    clock.advance(2_000);
    expect(manager.has(NODE_A)).toBe(false);
    expect(disposeRuntime).toHaveBeenCalledTimes(1);
    expect(disposeConnection).toHaveBeenCalledTimes(1);
  });

  test('引用计数未归零不释放', () => {
    const manager = createManager(clock);
    manager.acquire(NODE_A);
    manager.acquire(NODE_A);
    expect(manager.refCount(NODE_A)).toBe(2);

    manager.release(NODE_A);
    clock.advance(60_000);
    expect(manager.has(NODE_A)).toBe(true);
    expect(manager.refCount(NODE_A)).toBe(1);

    manager.release(NODE_A);
    clock.advance(60_000);
    expect(manager.has(NODE_A)).toBe(false);
  });

  test('宽限期内重新 acquire 复用同一运行时并取消释放', () => {
    const manager = createManager(clock);
    const first = manager.acquire(NODE_A);
    manager.release(NODE_A);
    clock.advance(10_000);

    const second = manager.acquire(NODE_A);
    expect(second).toBe(first);

    clock.advance(60_000);
    expect(manager.has(NODE_A)).toBe(true);
    expect(manager.refCount(NODE_A)).toBe(1);
    manager.disposeAll();
  });

  test('只 get 未 acquire 的运行时在宽限期后自动回收', () => {
    const manager = createManager(clock);
    manager.get(NODE_A);
    expect(clock.pending()).toBe(1);
    clock.advance(31_000);
    expect(manager.has(NODE_A)).toBe(false);
  });

  test('list 返回全部在册 node，disposeAll 清空', () => {
    const manager = createManager(clock);
    manager.acquire('self');
    manager.acquire(NODE_A);
    expect(
      manager
        .list()
        .map((e) => e.nodeId)
        .sort()
    ).toEqual([NODE_A, 'self']);
    manager.disposeAll();
    expect(manager.list()).toHaveLength(0);
  });

  test('引用计数 > 0 时 dispose 不生效', () => {
    const manager = createManager(clock);
    manager.acquire(NODE_A);
    manager.dispose(NODE_A);
    expect(manager.has(NODE_A)).toBe(true);
    manager.disposeAll();
  });
});

describe('WS 4401（会话失效）', () => {
  function harness() {
    const closed: string[] = [];
    const unauthorized: string[] = [];
    const onCloseByNode = new Map<string, (code: number) => void>();
    const manager = new NodeConnectionManager({
      graceMs: 30_000,
      setTimeoutFn: clock.schedule,
      clearTimeoutFn: clock.cancel,
      onUnauthorized: (nodeId) => unauthorized.push(nodeId),
      // 自建工厂**必须**拿到关闭码回调：manager 主动递给它，工厂没有忘记的余地。
      createConnection: (nodeId, onClose) => {
        onCloseByNode.set(nodeId, onClose);
        const connection = makeConnection();
        return {
          ...connection,
          client: { disconnect: () => closed.push(nodeId) } as never,
          dispose: () => undefined,
        };
      },
    });
    /** 模拟底层 socket 关闭：走工厂拿到的那个回调，而不是手动 notifyClose。 */
    const socketClose = (nodeId: string, code: number) => {
      const onClose = onCloseByNode.get(nodeId);
      if (!onClose) throw new Error(`no onClose handed to the factory for ${nodeId}`);
      onClose(code);
    };
    return { manager, closed, unauthorized, socketClose };
  }

  test('4401 停连接并按 node 派发一次鉴权事件（关闭码来自工厂拿到的回调）', () => {
    const { manager, closed, unauthorized, socketClose } = harness();
    manager.acquire(NODE_A);
    socketClose(NODE_A, WS_UNAUTHORIZED_CLOSE_CODE);
    expect(closed).toEqual([NODE_A]);
    expect(unauthorized).toEqual([NODE_A]);
    manager.disposeAll();
  });

  test('self 的 4401 同样走这条路径', () => {
    const { manager, unauthorized, socketClose } = harness();
    manager.acquire('self');
    socketClose('self', WS_UNAUTHORIZED_CLOSE_CODE);
    expect(unauthorized).toEqual(['self']);
    manager.disposeAll();
  });

  test('其它关闭码不做任何事（正常重连交给 ws-client）', () => {
    const { manager, closed, unauthorized, socketClose } = harness();
    manager.acquire(NODE_A);
    socketClose(NODE_A, 1006);
    socketClose(NODE_A, 1000);
    expect(closed).toEqual([]);
    expect(unauthorized).toEqual([]);
    manager.disposeAll();
  });
});

describe('onDispose', () => {
  test('runtime 真正被回收时才回调（宿主据此释放 QueryClient）', () => {
    const disposed: string[] = [];
    const manager = createManager(clock, { onDispose: (nodeId: string) => disposed.push(nodeId) });
    manager.acquire(NODE_A);
    manager.release(NODE_A);
    clock.advance(29_000);
    expect(disposed).toEqual([]);
    clock.advance(2_000);
    expect(disposed).toEqual([NODE_A]);
  });
});
