// 连接意图单一事实源的回归测试。覆盖合并后暴露的两个组合场景：
//  1. 同一挂载下路由 node 从 A 切到 B（provider 不重挂）——B 的键不能被 A 的意图覆写；
//  2. 同一个 node 并存多份 provider（路由层 + 侧栏聚合视图）——意图必须是同一份。

import { beforeEach, describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@tmex/stores/test-utils';
import type { DeviceIntentSnapshot } from './device-intent-store';

installWindowStorage();

const {
  DeviceIntentStore,
  deviceIntentStore,
  reconcileDeviceSubscriptions,
  resetDeviceIntentStores,
} = await import('./device-intent-store');

const PREFIX_A = 'n:0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a:';
const PREFIX_B = 'n:0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b:';

function connectedKey(prefix: string): string {
  return `${prefix}tmex:connectedDevices`;
}

function disconnectedKey(prefix: string): string {
  return `${prefix}tmex:disconnectedDevices`;
}

beforeEach(() => {
  localStorage.clear();
  resetDeviceIntentStores();
});

describe('deviceIntentStore 实例表', () => {
  test('同一 storagePrefix 恒返回同一实例，不同 prefix 相互独立', () => {
    expect(deviceIntentStore(PREFIX_A)).toBe(deviceIntentStore(PREFIX_A));
    expect(deviceIntentStore(PREFIX_A)).not.toBe(deviceIntentStore(PREFIX_B));
  });

  test('self 的空前缀沿用旧键名', () => {
    const store = new DeviceIntentStore('');
    expect(store.connectedKey).toBe('tmex:connectedDevices');
    expect(store.disconnectedKey).toBe('tmex:disconnectedDevices');
  });

  test('实例从自己的两个键读取初值', () => {
    localStorage.setItem(connectedKey(PREFIX_A), JSON.stringify(['dev-a1']));
    localStorage.setItem(disconnectedKey(PREFIX_A), JSON.stringify(['dev-a2']));
    const store = deviceIntentStore(PREFIX_A);
    expect([...store.getSnapshot().connected]).toEqual(['dev-a1']);
    expect([...store.getSnapshot().disconnected]).toEqual(['dev-a2']);
  });
});

describe('缺陷 1：同一挂载下路由 node 从 A 切到 B', () => {
  test('切换后 B 的两个存储键保持不变，意图来自 B 自己的存储', () => {
    localStorage.setItem(connectedKey(PREFIX_B), JSON.stringify(['dev-b1']));
    localStorage.setItem(disconnectedKey(PREFIX_B), JSON.stringify(['dev-b2']));

    // provider 每次渲染都按当前 runtime 的 storagePrefix 解析意图源。
    let storagePrefix = PREFIX_A;
    const resolveIntent = () => deviceIntentStore(storagePrefix);

    const intentA = resolveIntent();
    intentA.markConnectIntent('dev-a1');
    intentA.markDisconnectIntent('dev-a2');

    const bConnectedRaw = localStorage.getItem(connectedKey(PREFIX_B));
    const bDisconnectedRaw = localStorage.getItem(disconnectedKey(PREFIX_B));

    // 导航 /n/A/* → /n/B/*：组件树被复用，只是 storagePrefix 变了。
    storagePrefix = PREFIX_B;
    const intentB = resolveIntent();

    expect(intentB).not.toBe(intentA);
    expect(localStorage.getItem(connectedKey(PREFIX_B))).toBe(bConnectedRaw);
    expect(localStorage.getItem(disconnectedKey(PREFIX_B))).toBe(bDisconnectedRaw);
    expect([...intentB.getSnapshot().connected]).toEqual(['dev-b1']);
    expect([...intentB.getSnapshot().disconnected]).toEqual(['dev-b2']);
  });

  test('切到 B 之后继续在 B 上操作，只写 B 的键，A 的键不受影响', () => {
    const intentA = deviceIntentStore(PREFIX_A);
    intentA.markConnectIntent('dev-a1');
    const aConnectedRaw = localStorage.getItem(connectedKey(PREFIX_A));

    const intentB = deviceIntentStore(PREFIX_B);
    intentB.markConnectIntent('dev-b1');
    intentB.markDisconnectIntent('dev-b2');

    expect(localStorage.getItem(connectedKey(PREFIX_A))).toBe(aConnectedRaw);
    expect(localStorage.getItem(connectedKey(PREFIX_B))).toBe(JSON.stringify(['dev-b1']));
    expect(localStorage.getItem(disconnectedKey(PREFIX_B))).toBe(JSON.stringify(['dev-b2']));
    expect([...intentA.getSnapshot().connected]).toEqual(['dev-a1']);
  });

  test('切到 B 后的对账只按 B 的意图连 B 的设备', () => {
    localStorage.setItem(connectedKey(PREFIX_A), JSON.stringify(['dev-a1']));
    localStorage.setItem(connectedKey(PREFIX_B), JSON.stringify(['dev-b1']));
    deviceIntentStore(PREFIX_A).getSnapshot();

    const log: string[] = [];
    reconcileDeviceSubscriptions(
      deviceIntentStore(PREFIX_B),
      new Set(['dev-b1', 'dev-b2']),
      new Set<string>(),
      {
        connectDevice: (id) => log.push(`connect:${id}`),
        disconnectDevice: (id) => log.push(`disconnect:${id}`),
      }
    );

    expect(log).toEqual(['connect:dev-b1']);
  });
});

describe('缺陷 2：同一个 node 并存多份 provider', () => {
  test('两份 provider 拿到同一个意图源，一处显式断开另一处立即可见', () => {
    const outer = deviceIntentStore(PREFIX_A);
    const inner = deviceIntentStore(PREFIX_A);
    expect(inner).toBe(outer);

    outer.markConnectIntent('dev-1');
    const notified: DeviceIntentSnapshot[] = [];
    outer.subscribe(() => notified.push(outer.getSnapshot()));

    inner.markDisconnectIntent('dev-1');

    expect(notified.length).toBe(1);
    expect(outer.getSnapshot().disconnected.has('dev-1')).toBe(true);
    expect(outer.getSnapshot().connected.has('dev-1')).toBe(false);
  });

  test('显式断开后，另一份 provider 的对账不会把设备恢复订阅', () => {
    const outer = deviceIntentStore(PREFIX_A);
    const inner = deviceIntentStore(PREFIX_A);
    outer.markConnectIntent('dev-1');
    inner.markDisconnectIntent('dev-1');

    const log: string[] = [];
    reconcileDeviceSubscriptions(outer, new Set(['dev-1']), new Set<string>(), {
      connectDevice: (id) => log.push(`connect:${id}`),
      disconnectDevice: (id) => log.push(`disconnect:${id}`),
    });

    expect(log).toEqual([]);
  });

  test('退订监听后不再收到通知', () => {
    const store = deviceIntentStore(PREFIX_A);
    let count = 0;
    const unsubscribe = store.subscribe(() => {
      count += 1;
    });
    store.markConnectIntent('dev-1');
    unsubscribe();
    store.markDisconnectIntent('dev-1');
    expect(count).toBe(1);
  });
});

describe('快照与持久化', () => {
  test('无变化的意图操作不换快照引用、不通知', () => {
    const store = deviceIntentStore(PREFIX_A);
    store.markConnectIntent('dev-1');
    const snapshot = store.getSnapshot();
    let count = 0;
    store.subscribe(() => {
      count += 1;
    });

    store.markConnectIntent('dev-1');
    store.markConnectIntent('');
    store.markDisconnectIntent('');

    expect(store.getSnapshot()).toBe(snapshot);
    expect(count).toBe(0);
  });

  test('意图变化立即写回自己的键（不依赖 effect）', () => {
    const store = deviceIntentStore(PREFIX_A);
    store.markConnectIntent('dev-1');
    expect(localStorage.getItem(connectedKey(PREFIX_A))).toBe(JSON.stringify(['dev-1']));
    store.markDisconnectIntent('dev-1');
    expect(localStorage.getItem(connectedKey(PREFIX_A))).toBe('[]');
    expect(localStorage.getItem(disconnectedKey(PREFIX_A))).toBe(JSON.stringify(['dev-1']));
  });

  test('prune 清掉已删除设备并写回；无变化时不换引用', () => {
    const store = deviceIntentStore(PREFIX_A);
    store.markConnectIntent('dev-1');
    store.markDisconnectIntent('gone');

    store.pruneToKnownDevices(new Set(['dev-1', 'gone']));
    const unchanged = store.getSnapshot();
    store.pruneToKnownDevices(new Set(['dev-1', 'gone']));
    expect(store.getSnapshot()).toBe(unchanged);

    store.pruneToKnownDevices(new Set(['dev-1']));
    expect([...store.getSnapshot().disconnected]).toEqual([]);
    expect(localStorage.getItem(disconnectedKey(PREFIX_A))).toBe('[]');
  });
});

describe('reconcileDeviceSubscriptions', () => {
  test('退订已从设备列表消失的订阅，恢复仍存在的连接意图', () => {
    const store = deviceIntentStore(PREFIX_A);
    store.markConnectIntent('dev-1');
    store.markConnectIntent('deleted');

    const log: string[] = [];
    reconcileDeviceSubscriptions(store, new Set(['dev-1']), new Set(['deleted']), {
      connectDevice: (id) => log.push(`connect:${id}`),
      disconnectDevice: (id) => log.push(`disconnect:${id}`),
    });

    expect(log).toEqual(['disconnect:deleted', 'connect:dev-1']);
    expect([...store.getSnapshot().connected]).toEqual(['dev-1']);
  });

  test('已订阅的设备不重复下发连接', () => {
    const store = deviceIntentStore(PREFIX_A);
    store.markConnectIntent('dev-1');

    const log: string[] = [];
    reconcileDeviceSubscriptions(store, new Set(['dev-1']), new Set(['dev-1']), {
      connectDevice: (id) => log.push(`connect:${id}`),
      disconnectDevice: (id) => log.push(`disconnect:${id}`),
    });

    expect(log).toEqual([]);
  });
});
