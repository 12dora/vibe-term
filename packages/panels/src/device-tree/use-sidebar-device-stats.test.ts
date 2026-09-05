// 设备列表查询状态 → 分节判断。失败态的空数组不是事实，不能当成「这个 node 没有设备」，
// 更不能回写宿主的本地快照。

import { describe, expect, test } from 'bun:test';
import { type DeviceQueryStatus, deviceQueryFlags } from './use-sidebar-device-stats';

function status(overrides: Partial<DeviceQueryStatus> = {}): DeviceQueryStatus {
  return {
    isPending: false,
    isError: false,
    isSuccess: false,
    isPlaceholderData: false,
    ...overrides,
  };
}

describe('deviceQueryFlags', () => {
  test('首拉未落地：pending，既不算成功也不算失败', () => {
    expect(deviceQueryFlags(status({ isPending: true }))).toEqual({
      pending: true,
      failed: false,
      succeeded: false,
    });
  });

  test('占位数据算未落地，不允许回写快照', () => {
    expect(deviceQueryFlags(status({ isSuccess: true, isPlaceholderData: true }))).toEqual({
      pending: true,
      failed: false,
      succeeded: false,
    });
  });

  test('成功落地（含成功返回的空列表）才允许回写快照', () => {
    expect(deviceQueryFlags(status({ isSuccess: true }))).toEqual({
      pending: false,
      failed: false,
      succeeded: true,
    });
  });

  test('请求失败：非 pending 也非成功，快照保持原样', () => {
    expect(deviceQueryFlags(status({ isError: true }))).toEqual({
      pending: false,
      failed: true,
      succeeded: false,
    });
  });
});
