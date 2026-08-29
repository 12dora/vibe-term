import { describe, expect, test } from 'bun:test';
import type { DeviceConnectionStatus } from '@tmex/panels';
import {
  type DeviceConnectionSnapshot,
  MAX_PENDING_STATUS_MS,
  MIN_PENDING_STATUS_MS,
  createDeviceConnectionSnapshot,
  deriveDeviceConnectionStatus,
  deriveSettledConnectionStatus,
  isDeviceConnected,
  isPendingRequestSettled,
  pendingSettlementPlan,
  runPendingSettlement,
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

describe('在飞请求（防按钮闪烁）', () => {
  test('pending connect 稳定展示 connecting，哪怕真实态已经 connected', () => {
    const pending = new Map([[DEVICE, { kind: 'connect' as const, at: 0 }]]);
    const snapshot = { ...snapshotOf({ subscribed: true, connected: true }), pending };
    expect(deriveDeviceConnectionStatus(DEVICE, snapshot)).toBe('connecting');
    expect(deriveSettledConnectionStatus(DEVICE, snapshot)).toBe('connected');
  });

  test('pending disconnect 展示 disconnecting，而不是立刻跳回 disconnected', () => {
    const pending = new Map([[DEVICE, { kind: 'disconnect' as const, at: 0 }]]);
    const snapshot = { ...snapshotOf({ intentionallyDisconnected: true }), pending };
    expect(deriveDeviceConnectionStatus(DEVICE, snapshot)).toBe('disconnecting');
    expect(deriveSettledConnectionStatus(DEVICE, snapshot)).toBe('disconnected');
  });

  test('其它设备的 pending 不影响本设备', () => {
    const pending = new Map([['other', { kind: 'connect' as const, at: 0 }]]);
    expect(deriveDeviceConnectionStatus(DEVICE, { ...snapshotOf({}), pending })).toBe(
      'disconnected'
    );
  });

  test('落定判定：connect 到 connected / error / reconnecting 为止，disconnect 到 disconnected 为止', () => {
    const connect = { kind: 'connect' as const, at: 0 };
    const disconnect = { kind: 'disconnect' as const, at: 0 };
    expect(isPendingRequestSettled(connect, 'connected')).toBe(true);
    expect(isPendingRequestSettled(connect, 'error')).toBe(true);
    expect(isPendingRequestSettled(connect, 'reconnecting')).toBe(true);
    expect(isPendingRequestSettled(connect, 'connecting')).toBe(false);
    expect(isPendingRequestSettled(connect, 'disconnected')).toBe(false);
    expect(isPendingRequestSettled(disconnect, 'disconnected')).toBe(true);
    expect(isPendingRequestSettled(disconnect, 'connected')).toBe(false);
  });

  test('摘掉时机：落定且展示够最短时长立刻摘；不够就补足；没落定到最长时长按超时处理', () => {
    const request = { kind: 'connect' as const, at: 1000 };
    expect(pendingSettlementPlan(request, 'connected', 1000 + MIN_PENDING_STATUS_MS)).toEqual({
      delay: 0,
      action: 'settle',
    });
    expect(pendingSettlementPlan(request, 'connected', 1100)).toEqual({
      delay: MIN_PENDING_STATUS_MS - 100,
      action: 'settle',
    });
    expect(pendingSettlementPlan(request, 'connecting', 1100)).toEqual({
      delay: MAX_PENDING_STATUS_MS - 100,
      action: 'timeout',
    });
    expect(pendingSettlementPlan(request, 'connecting', 1000 + MAX_PENDING_STATUS_MS + 5)).toEqual({
      delay: 0,
      action: 'timeout',
    });
  });

  function fakeScheduler() {
    const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
    return {
      timers,
      schedule: (callback: () => void, delay: number) => {
        const entry = { callback, delay, cancelled: false };
        timers.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
      fire: () => {
        for (const timer of timers) if (!timer.cancelled) timer.callback();
      },
    };
  }

  test('8s 没回音：定时器到点后记 timeout 错误并摘掉 pending，按钮回到可点的「连接」', () => {
    const scheduler = fakeScheduler();
    const settled: string[] = [];
    const timedOut: string[] = [];
    const pending = new Map([[DEVICE, { kind: 'connect' as const, at: 0 }]]);
    const cancel = runPendingSettlement(pending, snapshotOf({ subscribed: true }), 100, {
      settle: (id) => settled.push(id),
      timeoutConnect: (id) => timedOut.push(id),
      schedule: scheduler.schedule,
    });
    expect(scheduler.timers.map((timer) => timer.delay)).toEqual([MAX_PENDING_STATUS_MS - 100]);
    expect(settled).toEqual([]);

    scheduler.fire();
    expect(timedOut).toEqual([DEVICE]);
    expect(settled).toEqual([DEVICE]);

    // 错误落进 store 之后：pending 已摘、真实态是 error → 按钮 action=connect
    const afterTimeout = snapshotOf({ subscribed: true, error: true });
    expect(deriveDeviceConnectionStatus(DEVICE, afterTimeout)).toBe('error');
    cancel();
  });

  test('超时前 effect 重跑（cleanup）会取消旧定时器；已落定的立刻摘且不记超时', () => {
    const scheduler = fakeScheduler();
    const settled: string[] = [];
    const timedOut: string[] = [];
    const cancel = runPendingSettlement(
      new Map([[DEVICE, { kind: 'connect' as const, at: 0 }]]),
      snapshotOf({ subscribed: true }),
      0,
      {
        settle: (id) => settled.push(id),
        timeoutConnect: (id) => timedOut.push(id),
        schedule: scheduler.schedule,
      }
    );
    cancel();
    scheduler.fire();
    expect(settled).toEqual([]);
    expect(timedOut).toEqual([]);

    runPendingSettlement(
      new Map([[DEVICE, { kind: 'connect' as const, at: 0 }]]),
      snapshotOf({ subscribed: true, connected: true }),
      MIN_PENDING_STATUS_MS,
      {
        settle: (id) => settled.push(id),
        timeoutConnect: (id) => timedOut.push(id),
        schedule: scheduler.schedule,
      }
    );
    expect(settled).toEqual([DEVICE]);
    expect(timedOut).toEqual([]);

    // disconnect 请求超时只摘掉，不记 connect 超时错误
    const disconnectScheduler = fakeScheduler();
    runPendingSettlement(
      new Map([[DEVICE, { kind: 'disconnect' as const, at: 0 }]]),
      snapshotOf({ subscribed: true, connected: true }),
      MAX_PENDING_STATUS_MS,
      {
        settle: (id) => settled.push(id),
        timeoutConnect: (id) => timedOut.push(id),
        schedule: disconnectScheduler.schedule,
      }
    );
    expect(settled).toEqual([DEVICE, DEVICE]);
    expect(timedOut).toEqual([]);
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
