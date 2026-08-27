import { describe, expect, test } from 'bun:test';
import {
  type DeviceConnectionSnapshot,
  type DeviceIdStorage,
  deriveDeviceConnectionStatus,
  pruneUnknownDeviceIds,
  readPersistedIds,
  shouldEnsureDeviceSubscription,
  shouldEnsureRouteDeviceSubscription,
  writePersistedIds,
} from './global-device-provider';

function createMemoryStorage(initial: Record<string, string> = {}): DeviceIdStorage & {
  entries: Map<string, string>;
} {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

function createSnapshot(
  overrides: Partial<DeviceConnectionSnapshot> = {}
): DeviceConnectionSnapshot {
  return {
    intentionallyDisconnected: new Set<string>(),
    connectedDevices: new Set<string>(),
    deviceConnected: {},
    deviceErrors: {},
    deviceReconnecting: {},
    ...overrides,
  };
}

describe('shouldEnsureRouteDeviceSubscription', () => {
  test('设备列表尚未加载时订阅非空路由设备', () => {
    expect(shouldEnsureRouteDeviceSubscription('device-a', undefined)).toBe(true);
  });

  test('已加载的设备列表包含路由设备时订阅', () => {
    expect(
      shouldEnsureRouteDeviceSubscription('device-a', {
        devices: [{ id: 'device-a' }],
      })
    ).toBe(true);
  });

  test('路由设备不在已加载的设备列表中时不订阅', () => {
    expect(
      shouldEnsureRouteDeviceSubscription('deleted-device', {
        devices: [{ id: 'device-a' }],
      })
    ).toBe(false);
  });

  test('路由设备 ID 缺失时不订阅', () => {
    expect(shouldEnsureRouteDeviceSubscription(undefined, undefined)).toBe(false);
    expect(shouldEnsureRouteDeviceSubscription('', undefined)).toBe(false);
  });
});

describe('shouldEnsureDeviceSubscription', () => {
  test('未订阅且未被主动断开时订阅', () => {
    expect(shouldEnsureDeviceSubscription('device-a', new Set(), new Set())).toBe(true);
  });

  test('已在 connectedDevices 中时不重复订阅', () => {
    expect(shouldEnsureDeviceSubscription('device-a', new Set(), new Set(['device-a']))).toBe(
      false
    );
  });

  test('主动断开的设备不再自动订阅', () => {
    expect(shouldEnsureDeviceSubscription('device-a', new Set(['device-a']), new Set())).toBe(
      false
    );
  });

  test('设备 ID 为空时不订阅', () => {
    expect(shouldEnsureDeviceSubscription('', new Set(), new Set())).toBe(false);
  });
});

describe('deriveDeviceConnectionStatus', () => {
  test('主动断开优先于任何运行态', () => {
    const snapshot = createSnapshot({
      intentionallyDisconnected: new Set(['device-a']),
      connectedDevices: new Set(['device-a']),
      deviceConnected: { 'device-a': true },
      deviceErrors: { 'device-a': { message: 'boom', type: 'x', at: 0 } },
      deviceReconnecting: { 'device-a': { message: 'retry', at: 0 } },
    });
    expect(deriveDeviceConnectionStatus('device-a', snapshot)).toBe('disconnected');
  });

  test('重连中优先于错误与已连接', () => {
    const snapshot = createSnapshot({
      deviceConnected: { 'device-a': true },
      deviceErrors: { 'device-a': { message: 'boom', type: 'x', at: 0 } },
      deviceReconnecting: { 'device-a': { message: 'retry', at: 0 } },
    });
    expect(deriveDeviceConnectionStatus('device-a', snapshot)).toBe('reconnecting');
  });

  test('错误优先于已连接', () => {
    const snapshot = createSnapshot({
      deviceConnected: { 'device-a': true },
      deviceErrors: { 'device-a': { message: 'boom', type: 'x', at: 0 } },
    });
    expect(deriveDeviceConnectionStatus('device-a', snapshot)).toBe('error');
  });

  test('网关确认连接后为 connected', () => {
    const snapshot = createSnapshot({
      connectedDevices: new Set(['device-a']),
      deviceConnected: { 'device-a': true },
    });
    expect(deriveDeviceConnectionStatus('device-a', snapshot)).toBe('connected');
  });

  test('已订阅但未确认时为 connecting', () => {
    const snapshot = createSnapshot({ connectedDevices: new Set(['device-a']) });
    expect(deriveDeviceConnectionStatus('device-a', snapshot)).toBe('connecting');
  });

  test('未订阅时为 disconnected', () => {
    expect(deriveDeviceConnectionStatus('device-a', createSnapshot())).toBe('disconnected');
    expect(deriveDeviceConnectionStatus('', createSnapshot())).toBe('disconnected');
  });

  test('原型链键不会被误判为已连接或出错', () => {
    expect(deriveDeviceConnectionStatus('constructor', createSnapshot())).toBe('disconnected');
    expect(deriveDeviceConnectionStatus('toString', createSnapshot())).toBe('disconnected');
  });
});

describe('readPersistedIds / writePersistedIds', () => {
  test('读取旧实现写入的 tmex:connectedDevices 数组', () => {
    const storage = createMemoryStorage({
      'tmex:connectedDevices': JSON.stringify(['device-a', 'device-b']),
    });
    expect([...readPersistedIds('tmex:connectedDevices', storage)]).toEqual([
      'device-a',
      'device-b',
    ]);
  });

  test('缺失、非法 JSON、非数组均回退为空集合', () => {
    const storage = createMemoryStorage({
      broken: '{oops',
      object: '{"a":1}',
      empty: '',
    });
    expect(readPersistedIds('missing', storage).size).toBe(0);
    expect(readPersistedIds('broken', storage).size).toBe(0);
    expect(readPersistedIds('object', storage).size).toBe(0);
    expect(readPersistedIds('empty', storage).size).toBe(0);
  });

  test('过滤非字符串与空字符串元素', () => {
    const storage = createMemoryStorage({
      key: JSON.stringify(['device-a', 1, null, '', 'device-b']),
    });
    expect([...readPersistedIds('key', storage)]).toEqual(['device-a', 'device-b']);
  });

  test('写入为 JSON 字符串数组并可回读', () => {
    const storage = createMemoryStorage();
    writePersistedIds('tmex:disconnectedDevices', new Set(['device-a']), storage);
    expect(storage.entries.get('tmex:disconnectedDevices')).toBe('["device-a"]');
    expect([...readPersistedIds('tmex:disconnectedDevices', storage)]).toEqual(['device-a']);
  });

  test('无可用 storage 时读写不抛出', () => {
    expect(readPersistedIds('key', null).size).toBe(0);
    expect(() => writePersistedIds('key', new Set(['device-a']), null)).not.toThrow();
  });
});

describe('pruneUnknownDeviceIds', () => {
  test('删除已不存在的设备 ID', () => {
    const ids = new Set(['device-a', 'deleted']);
    const next = pruneUnknownDeviceIds(ids, new Set(['device-a']));
    expect([...next]).toEqual(['device-a']);
    expect(next).not.toBe(ids);
  });

  test('无变化时返回原引用', () => {
    const ids = new Set(['device-a']);
    expect(pruneUnknownDeviceIds(ids, new Set(['device-a', 'device-b']))).toBe(ids);
  });
});
