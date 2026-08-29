// 顶栏「新建分组 / 恢复默认布局」命令注册表。

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  type DevicesPageCommands,
  getDevicesPageCommands,
  registerDevicesPageCommands,
  resetDevicesPageCommandsForTest,
  subscribeDevicesPageCommands,
} from './page-commands';

function commands(): DevicesPageCommands {
  return { newFolder: () => undefined, resetLayout: () => undefined, layoutBusy: false };
}

describe('page-commands 注册表', () => {
  beforeEach(() => resetDevicesPageCommandsForTest());

  test('登记后顶栏拿得到命令，注销后回到空', () => {
    expect(getDevicesPageCommands()).toBeNull();
    const current = commands();
    const unregister = registerDevicesPageCommands(current);
    expect(getDevicesPageCommands()).toBe(current);
    unregister();
    expect(getDevicesPageCommands()).toBeNull();
  });

  test('旧的注销函数不会摘掉后来者（页面重挂时的顺序问题）', () => {
    const first = commands();
    const second = commands();
    const unregisterFirst = registerDevicesPageCommands(first);
    registerDevicesPageCommands(second);
    unregisterFirst();
    expect(getDevicesPageCommands()).toBe(second);
  });

  test('订阅者在登记 / 注销时各被通知一次', () => {
    let notified = 0;
    const unsubscribe = subscribeDevicesPageCommands(() => {
      notified += 1;
    });
    const unregister = registerDevicesPageCommands(commands());
    unregister();
    unsubscribe();
    expect(notified).toBe(2);
  });
});
