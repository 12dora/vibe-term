import { describe, expect, test } from 'bun:test';
import type { DeviceConnectionStatus } from '@tmex/panels';
import {
  type DeviceConnectionSnapshot,
  createDeviceConnectionSnapshot,
  deriveDeviceConnectionStatus,
  isDeviceConnected,
  matchRouteDeviceId,
  selectRestorableDeviceIds,
  selectStaleSubscribedDeviceIds,
  shouldEnsureDeviceSubscription,
  shouldEnsureRouteDeviceSubscription,
} from './device-connection-status';

const DEVICE = 'device-a';

interface SnapshotFlags {
  intentionallyDisconnected: boolean;
  subscribed: boolean;
  connected: boolean;
  error: boolean;
  reconnecting: boolean;
}

function snapshotOf(flags: Partial<SnapshotFlags>): DeviceConnectionSnapshot {
  return {
    intentionallyDisconnected: new Set(flags.intentionallyDisconnected ? [DEVICE] : []),
    connectedDevices: new Set(flags.subscribed ? [DEVICE] : []),
    deviceConnected: flags.connected ? { [DEVICE]: true } : {},
    deviceErrors: flags.error ? { [DEVICE]: { message: 'boom', type: 'x', at: 0 } } : {},
    deviceReconnecting: flags.reconnecting ? { [DEVICE]: { message: 'retry', at: 0 } } : {},
  };
}

describe('deriveDeviceConnectionStatus 优先级矩阵', () => {
  const matrix: Array<[string, Partial<SnapshotFlags>, DeviceConnectionStatus]> = [
    ['全部为假', {}, 'disconnected'],
    ['仅已订阅', { subscribed: true }, 'connecting'],
    ['已订阅且网关确认', { subscribed: true, connected: true }, 'connected'],
    ['未订阅但网关确认', { connected: true }, 'connected'],
    ['有错误', { subscribed: true, error: true }, 'error'],
    ['错误优先于已连接', { subscribed: true, connected: true, error: true }, 'error'],
    ['重连中', { subscribed: true, reconnecting: true }, 'reconnecting'],
    [
      '重连中优先于错误与已连接',
      { subscribed: true, connected: true, error: true, reconnecting: true },
      'reconnecting',
    ],
    ['主动断开优先于已订阅', { intentionallyDisconnected: true, subscribed: true }, 'disconnected'],
    [
      '主动断开优先于全部运行态',
      {
        intentionallyDisconnected: true,
        subscribed: true,
        connected: true,
        error: true,
        reconnecting: true,
      },
      'disconnected',
    ],
  ];

  for (const [name, flags, expected] of matrix) {
    test(`${name} → ${expected}`, () => {
      expect(deriveDeviceConnectionStatus(DEVICE, snapshotOf(flags))).toBe(expected);
    });
  }

  test('设备 ID 为空时为 disconnected', () => {
    expect(deriveDeviceConnectionStatus('', snapshotOf({ connected: true }))).toBe('disconnected');
  });

  test('原型链键不会被误判', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(deriveDeviceConnectionStatus(key, snapshotOf({}))).toBe('disconnected');
    }
  });

  test('deviceConnected 显式为 false 时不算已连接', () => {
    const snapshot: DeviceConnectionSnapshot = {
      ...snapshotOf({ subscribed: true }),
      deviceConnected: { [DEVICE]: false },
    };
    expect(deriveDeviceConnectionStatus(DEVICE, snapshot)).toBe('connecting');
  });
});

describe('createDeviceConnectionSnapshot', () => {
  test('把连接意图与 store 切片合并为快照', () => {
    const intentionallyDisconnected = new Set([DEVICE]);
    const snapshot = createDeviceConnectionSnapshot(intentionallyDisconnected, {
      connectedDevices: new Set([DEVICE]),
      deviceConnected: { [DEVICE]: true },
      deviceErrors: {},
      deviceReconnecting: {},
    });
    expect(snapshot.intentionallyDisconnected).toBe(intentionallyDisconnected);
    expect(deriveDeviceConnectionStatus(DEVICE, snapshot)).toBe('disconnected');
  });
});

describe('isDeviceConnected', () => {
  test('仅在值严格为 true 时返回 true', () => {
    expect(isDeviceConnected({ [DEVICE]: true }, DEVICE)).toBe(true);
    expect(isDeviceConnected({ [DEVICE]: false }, DEVICE)).toBe(false);
    expect(isDeviceConnected({}, DEVICE)).toBe(false);
  });

  test('原型链键返回 false', () => {
    expect(isDeviceConnected({}, 'toString')).toBe(false);
  });
});

describe('shouldEnsureRouteDeviceSubscription', () => {
  test('设备列表尚未加载时订阅非空路由设备', () => {
    expect(shouldEnsureRouteDeviceSubscription(DEVICE, undefined)).toBe(true);
  });

  test('已加载的设备列表包含路由设备时订阅', () => {
    expect(shouldEnsureRouteDeviceSubscription(DEVICE, { devices: [{ id: DEVICE }] })).toBe(true);
  });

  test('路由设备不在设备列表中时不订阅', () => {
    expect(shouldEnsureRouteDeviceSubscription('deleted', { devices: [{ id: DEVICE }] })).toBe(
      false
    );
  });

  test('路由设备 ID 缺失时不订阅', () => {
    expect(shouldEnsureRouteDeviceSubscription(undefined, undefined)).toBe(false);
    expect(shouldEnsureRouteDeviceSubscription('', undefined)).toBe(false);
  });
});

describe('shouldEnsureDeviceSubscription', () => {
  test('未订阅且未被主动断开时订阅', () => {
    expect(shouldEnsureDeviceSubscription(DEVICE, new Set(), new Set())).toBe(true);
  });

  test('已订阅时不重复下发', () => {
    expect(shouldEnsureDeviceSubscription(DEVICE, new Set(), new Set([DEVICE]))).toBe(false);
  });

  test('主动断开的设备不再自动订阅', () => {
    expect(shouldEnsureDeviceSubscription(DEVICE, new Set([DEVICE]), new Set())).toBe(false);
  });

  test('设备 ID 为空时不订阅', () => {
    expect(shouldEnsureDeviceSubscription('', new Set(), new Set())).toBe(false);
  });
});

describe('matchRouteDeviceId', () => {
  test('从设备路由中取出 ID', () => {
    expect(matchRouteDeviceId('/devices/device-a')).toBe('device-a');
    expect(matchRouteDeviceId('/devices/device-a/sessions/1')).toBe('device-a');
  });

  test('非设备路由返回 undefined', () => {
    expect(matchRouteDeviceId('/')).toBeUndefined();
    expect(matchRouteDeviceId('/devices')).toBeUndefined();
    expect(matchRouteDeviceId('/settings/devices/device-a')).toBeUndefined();
  });
});

describe('selectStaleSubscribedDeviceIds', () => {
  test('只返回已订阅但已从列表删除的设备', () => {
    expect(selectStaleSubscribedDeviceIds(new Set([DEVICE, 'deleted']), new Set([DEVICE]))).toEqual(
      ['deleted']
    );
  });

  test('全部已知时返回空数组', () => {
    expect(selectStaleSubscribedDeviceIds(new Set([DEVICE]), new Set([DEVICE]))).toEqual([]);
  });
});

describe('selectRestorableDeviceIds', () => {
  test('恢复仍存在且未订阅的连接意图', () => {
    expect(
      selectRestorableDeviceIds(new Set([DEVICE, 'gone']), new Set([DEVICE]), new Set(), new Set())
    ).toEqual([DEVICE]);
  });

  test('已订阅的不重复恢复', () => {
    expect(
      selectRestorableDeviceIds(new Set([DEVICE]), new Set([DEVICE]), new Set(), new Set([DEVICE]))
    ).toEqual([]);
  });

  test('主动断开的不恢复', () => {
    expect(
      selectRestorableDeviceIds(new Set([DEVICE]), new Set([DEVICE]), new Set([DEVICE]), new Set())
    ).toEqual([]);
  });
});
