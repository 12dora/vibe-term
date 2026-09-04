// 「添加 SSH 设备」按钮的打开时机：设备页还没挂上时先等注册表，等到了立刻开对话框。

import { describe, expect, test } from 'bun:test';
import type { AddDeviceTarget } from '@/pages/devices/add-device-targets';
import { type AddDeviceTargetSource, openSelfAddDevice } from './open-add-device';

function target(over: Partial<AddDeviceTarget> = {}): AddDeviceTarget {
  return {
    runtimeNodeId: 'self',
    name: 'self',
    isSelf: true,
    open: () => undefined,
    ...over,
  };
}

/** 可控的注册表替身：`publish()` 模拟设备页挂载后登记自己。 */
function source(): AddDeviceTargetSource & {
  publish: (targets: AddDeviceTarget[]) => void;
  subscribers: number;
} {
  let rows: AddDeviceTarget[] = [];
  const listeners = new Set<() => void>();
  return {
    get: () => rows,
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    publish(next) {
      rows = next;
      for (const listener of [...listeners]) listener();
    },
    get subscribers() {
      return listeners.size;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('openSelfAddDevice', () => {
  test('注册表里已有本机目标：推迟一拍后打开，并撤掉订阅', async () => {
    const store = source();
    let opened = 0;
    store.publish([target({ open: () => opened++ })]);
    openSelfAddDevice({ source: store });
    expect(opened).toBe(0);
    await tick();
    expect(opened).toBe(1);
    expect(store.subscribers).toBe(0);
  });

  test('设备页稍后才登记：登记到位立刻打开，且只开一次', async () => {
    const store = source();
    let opened = 0;
    openSelfAddDevice({ source: store });
    await tick();
    expect(opened).toBe(0);
    store.publish([target({ open: () => opened++ })]);
    expect(opened).toBe(1);
    store.publish([target({ open: () => opened++ })]);
    expect(opened).toBe(1);
  });

  test('只认本机那条：别的节点登记了也不开', async () => {
    const store = source();
    let opened = 0;
    openSelfAddDevice({ source: store });
    store.publish([target({ runtimeNodeId: 'other', isSelf: false, open: () => opened++ })]);
    await tick();
    expect(opened).toBe(0);
    expect(store.subscribers).toBe(1);
  });

  test('取消后不再打开，订阅也不留着', async () => {
    const store = source();
    let opened = 0;
    const cancel = openSelfAddDevice({ source: store });
    cancel();
    expect(store.subscribers).toBe(0);
    store.publish([target({ open: () => opened++ })]);
    await tick();
    expect(opened).toBe(0);
  });

  test('等不到就放弃，不把订阅留在后面', async () => {
    const store = source();
    let opened = 0;
    openSelfAddDevice({ source: store, timeoutMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.subscribers).toBe(0);
    store.publish([target({ open: () => opened++ })]);
    expect(opened).toBe(0);
  });
});
