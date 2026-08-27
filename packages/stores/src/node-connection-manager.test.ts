import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { nodeWsUrl } from '@tmex/api-client';
import { type GatewayConnection, createGatewayConnection } from '@tmex/ws-client';
import { NodeConnectionManager, nodeStoragePrefix } from './node-connection-manager';
import { installWindowStorage } from './test-utils';

installWindowStorage();

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
    expect(nodeStoragePrefix('node-a')).toBe('n:node-a:');
  });
});

describe('NodeConnectionManager.get', () => {
  test('同一 nodeId 复用同一份运行时', () => {
    const manager = createManager(clock);
    expect(manager.get('self')).toBe(manager.get('self'));
    expect(manager.get('node-a')).toBe(manager.get('node-a'));
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
    const a = manager.acquire('node-a');
    const b = manager.acquire('node-b');

    expect(a.runtime).not.toBe(b.runtime);
    expect(a.connection).not.toBe(b.connection);
    expect(a.apiClient.baseUrl).toBe('/n/node-a');
    expect(b.apiClient.baseUrl).toBe('/n/node-b');
    expect(a.runtime.storagePrefix).toBe('n:node-a:');
    expect(b.runtime.storagePrefix).toBe('n:node-b:');
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
    const a = manager.get('node-a');
    expect(self.runtime.host.appPath?.('/devices/d1') ?? '/devices/d1').toBe('/devices/d1');
    expect(a.runtime.host.appPath?.('/devices/d1')).toBe('/n/node-a/devices/d1');
    manager.disposeAll();
  });

  test('默认 WS 地址按 node 解析', () => {
    expect(nodeWsUrl('self', { protocol: 'https:', host: 'h' })).toBe('wss://h/ws');
    expect(nodeWsUrl('node-a', { protocol: 'https:', host: 'h' })).toBe('wss://h/n/node-a/ws');
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

    manager.acquire('node-a');
    manager.release('node-a');
    expect(manager.has('node-a')).toBe(true);

    clock.advance(29_000);
    expect(manager.has('node-a')).toBe(true);
    expect(disposeRuntime).not.toHaveBeenCalled();

    clock.advance(2_000);
    expect(manager.has('node-a')).toBe(false);
    expect(disposeRuntime).toHaveBeenCalledTimes(1);
    expect(disposeConnection).toHaveBeenCalledTimes(1);
  });

  test('引用计数未归零不释放', () => {
    const manager = createManager(clock);
    manager.acquire('node-a');
    manager.acquire('node-a');
    expect(manager.refCount('node-a')).toBe(2);

    manager.release('node-a');
    clock.advance(60_000);
    expect(manager.has('node-a')).toBe(true);
    expect(manager.refCount('node-a')).toBe(1);

    manager.release('node-a');
    clock.advance(60_000);
    expect(manager.has('node-a')).toBe(false);
  });

  test('宽限期内重新 acquire 复用同一运行时并取消释放', () => {
    const manager = createManager(clock);
    const first = manager.acquire('node-a');
    manager.release('node-a');
    clock.advance(10_000);

    const second = manager.acquire('node-a');
    expect(second).toBe(first);

    clock.advance(60_000);
    expect(manager.has('node-a')).toBe(true);
    expect(manager.refCount('node-a')).toBe(1);
    manager.disposeAll();
  });

  test('只 get 未 acquire 的运行时在宽限期后自动回收', () => {
    const manager = createManager(clock);
    manager.get('node-a');
    expect(clock.pending()).toBe(1);
    clock.advance(31_000);
    expect(manager.has('node-a')).toBe(false);
  });

  test('list 返回全部在册 node，disposeAll 清空', () => {
    const manager = createManager(clock);
    manager.acquire('self');
    manager.acquire('node-a');
    expect(
      manager
        .list()
        .map((e) => e.nodeId)
        .sort()
    ).toEqual(['node-a', 'self']);
    manager.disposeAll();
    expect(manager.list()).toHaveLength(0);
  });

  test('引用计数 > 0 时 dispose 不生效', () => {
    const manager = createManager(clock);
    manager.acquire('node-a');
    manager.dispose('node-a');
    expect(manager.has('node-a')).toBe(true);
    manager.disposeAll();
  });
});
