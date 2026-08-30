// 连接态按设备分发：一台设备的连接事件只唤醒订阅了这台设备的那一个监听者。
// 仓库没有 DOM 测试环境（见 global-device-provider-shared-intent.test.tsx 的说明），
// 「20 台设备只重渲染一行」在这里以「20 个监听者只唤醒 1 个」的形式断言——每个挂载的
// DeviceRow / DeviceCard 通过 `useSyncExternalStore` 恰好登记一个监听者。

import { describe, expect, test } from 'bun:test';
import { createDeviceConnectionSnapshot } from './device-connection-status';
import { DeviceStatusStore } from './device-status-store';

const DEVICE_IDS = Array.from({ length: 20 }, (_, index) => `dev-${index}`);

function snapshotOf(
  connected: readonly string[],
  intentionallyDisconnected: readonly string[] = []
) {
  return createDeviceConnectionSnapshot(new Set(intentionallyDisconnected), {
    connectedDevices: new Set(connected),
    deviceConnected: Object.fromEntries(connected.map((deviceId) => [deviceId, true])),
    deviceErrors: {},
    deviceReconnecting: {},
  });
}

/** 建一个已挂 20 台设备监听者的 store，返回每台设备的唤醒计数 */
function mountRows(store: DeviceStatusStore): Map<string, number> {
  const woken = new Map(DEVICE_IDS.map((deviceId) => [deviceId, 0]));
  for (const deviceId of DEVICE_IDS) {
    store.subscribe(deviceId, () => woken.set(deviceId, (woken.get(deviceId) ?? 0) + 1));
  }
  return woken;
}

describe('DeviceStatusStore', () => {
  test('一台设备连上：20 个监听者里只唤醒它自己那一个', () => {
    const store = new DeviceStatusStore(snapshotOf([]));
    const woken = mountRows(store);

    store.publish(snapshotOf(['dev-7']));

    expect([...woken].filter(([, count]) => count > 0)).toEqual([['dev-7', 1]]);
    expect(store.status('dev-7')).toBe('connected');
    expect(store.status('dev-6')).toBe('disconnected');
  });

  test('主动断开意图同样只唤醒那一台', () => {
    const store = new DeviceStatusStore(snapshotOf(DEVICE_IDS));
    const woken = mountRows(store);

    store.publish(snapshotOf(DEVICE_IDS, ['dev-3']));

    expect([...woken].filter(([, count]) => count > 0)).toEqual([['dev-3', 1]]);
    expect(store.isIntentionallyDisconnected('dev-3')).toBe(true);
    expect(store.isIntentionallyDisconnected('dev-4')).toBe(false);
  });

  test('快照换了新引用但推导值没变：一个都不唤醒', () => {
    const store = new DeviceStatusStore(snapshotOf(['dev-1']));
    const woken = mountRows(store);

    store.publish(snapshotOf(['dev-1']));

    expect([...woken.values()].every((count) => count === 0)).toBe(true);
  });

  test('未提交的快照不可见：纯函数算好但没 publish，读到的还是上一帧', () => {
    const store = new DeviceStatusStore(snapshotOf([]));
    const woken = mountRows(store);

    // 模拟被 React 放弃的并发渲染：快照算出来了，提交后的 useLayoutEffect 没跑
    const abandoned = snapshotOf(['dev-1']);

    expect(store.isConnected('dev-1')).toBe(false);
    expect(store.status('dev-1')).toBe('disconnected');
    expect([...woken.values()].every((count) => count === 0)).toBe(true);

    store.publish(abandoned);

    expect(store.isConnected('dev-1')).toBe(true);
    expect(woken.get('dev-1')).toBe(1);
  });

  test('publish 一步到位：监听者被唤醒时读到的已经是新值', () => {
    const store = new DeviceStatusStore(snapshotOf([]));
    const seen: string[] = [];
    store.subscribe('dev-1', () => seen.push(store.status('dev-1')));

    store.publish(snapshotOf(['dev-1']));

    expect(seen).toEqual(['connected']);
  });

  test('退订后不再被唤醒，最后一个监听者走掉即摘掉该设备的登记', () => {
    const store = new DeviceStatusStore(snapshotOf([]));
    let woken = 0;
    const unsubscribe = store.subscribe('dev-1', () => {
      woken += 1;
    });

    unsubscribe();
    unsubscribe();
    store.publish(snapshotOf(['dev-1']));

    expect(woken).toBe(0);
  });

  test('同一台设备的多个监听者都会被唤醒（一行 + 一张卡片同时挂着）', () => {
    const store = new DeviceStatusStore(snapshotOf([]));
    let row = 0;
    let card = 0;
    store.subscribe('dev-1', () => {
      row += 1;
    });
    store.subscribe('dev-1', () => {
      card += 1;
    });

    store.publish(snapshotOf(['dev-1']));

    expect([row, card]).toEqual([1, 1]);
  });

  test('在飞请求先落到 connecting，落定后再唤醒一次', () => {
    const store = new DeviceStatusStore(snapshotOf([]));
    const woken = mountRows(store);

    const pending = new Map([['dev-2', { kind: 'connect' as const, at: 0 }]]);
    store.publish(
      createDeviceConnectionSnapshot(
        new Set(),
        {
          connectedDevices: new Set<string>(),
          deviceConnected: {},
          deviceErrors: {},
          deviceReconnecting: {},
        },
        pending
      )
    );
    expect(store.status('dev-2')).toBe('connecting');

    store.publish(snapshotOf(['dev-2']));

    expect(woken.get('dev-2')).toBe(2);
    expect([...woken].filter(([, count]) => count > 0)).toEqual([['dev-2', 2]]);
  });
});
