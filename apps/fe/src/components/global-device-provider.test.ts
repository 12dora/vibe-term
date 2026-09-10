import { beforeEach, describe, expect, test } from 'bun:test';
import { ApiClient, nodeAppPath } from '@vibeterm/api-client';
import type { Device } from '@vibeterm/shared';
import {
  clearTmuxTopologyCache,
  nodeStoragePrefix,
  pruneTmuxTopologyCache,
  readTmuxTopologyCache,
  writeTmuxTopology,
} from '@vibeterm/stores';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { writeDeviceSnapshot } = await import('@/pages/devices/device-snapshot-store');
const { devicesQueryOptions, routeDeviceId } = await import('./global-device-provider');

const selfAppPath = (path: string) => nodeAppPath('self', path);
const nodeAAppPath = (path: string) => nodeAppPath('0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a', path);

describe('devicesQueryOptions', () => {
  const apiClient = new ApiClient('http://devices-query.test');

  test('在线 node 照常查询设备列表', () => {
    const options = devicesQueryOptions(apiClient, false);
    expect(options.queryKey).toEqual(['devices']);
    expect(options.enabled).toBe(true);
  });

  test('离线 node 不发 /api/devices（每个 node 各有 QueryClient，否则 N 个离线 node 就是 N 条注定失败的请求）', () => {
    expect(devicesQueryOptions(apiClient, true).enabled).toBe(false);
  });

  test('离线→在线翻回来即重新启用，query key 不变（缓存与订阅照常复用）', () => {
    const offline = devicesQueryOptions(apiClient, true);
    const online = devicesQueryOptions(apiClient, false);
    expect(offline.queryKey).toEqual(online.queryKey);
    expect([offline.enabled, online.enabled]).toEqual([false, true]);
  });
});

describe('devicesQueryOptions 的首帧占位', () => {
  const apiClient = new ApiClient('http://devices-placeholder.test');
  const NODE_ID = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
  const DEVICE: Device = {
    id: 'd1',
    name: '书房',
    type: 'local',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    localStorage.clear();
  });

  test('没有快照（或没给 nodeId）时不带占位', () => {
    expect(devicesQueryOptions(apiClient, false, NODE_ID).placeholderData).toBeUndefined();
    writeDeviceSnapshot(NODE_ID, [DEVICE]);
    expect(devicesQueryOptions(apiClient, false).placeholderData).toBeUndefined();
  });

  test('有快照时首帧直接给出设备列表，请求照常发出', () => {
    writeDeviceSnapshot(NODE_ID, [DEVICE]);
    const options = devicesQueryOptions(apiClient, false, NODE_ID);
    expect(options.placeholderData?.devices.map((device) => device.id)).toEqual(['d1']);
    expect(options.enabled).toBe(true);
  });

  test('快照按 node 分键，不会串到别的 node', () => {
    writeDeviceSnapshot(NODE_ID, [DEVICE]);
    expect(devicesQueryOptions(apiClient, false, 'self').placeholderData).toBeUndefined();
  });
});

describe('routeDeviceId', () => {
  test('self runtime 匹配旧路由', () => {
    expect(routeDeviceId('/devices/device-a', selfAppPath)).toBe('device-a');
    expect(routeDeviceId('/devices/device-a/windows/w1/panes/p1', selfAppPath)).toBe('device-a');
    expect(routeDeviceId('/settings', selfAppPath)).toBeUndefined();
  });

  test('self runtime 不认领别的 node 的路径', () => {
    expect(
      routeDeviceId('/n/0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a/devices/device-a', selfAppPath)
    ).toBeUndefined();
  });

  test('node runtime 只匹配自己的 /n/:nodeId 路径', () => {
    expect(
      routeDeviceId('/n/0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a/devices/device-a', nodeAAppPath)
    ).toBe('device-a');
    expect(
      routeDeviceId('/n/0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b/devices/device-a', nodeAAppPath)
    ).toBeUndefined();
    expect(routeDeviceId('/devices/device-a', nodeAAppPath)).toBeUndefined();
  });
});

// 设备列表落地后顺带清掉已删设备的拓扑缓存（`useReconcileWithDeviceList`）。
// hook 本身在无 DOM 的 bun test 里跑不起来，这里锁住它依赖的两条契约：
// 缓存按 runtime.storagePrefix 分区，且 prune 只留下仍在列表里的设备。
describe('拓扑缓存随设备列表对账', () => {
  test('按 runtime.storagePrefix 分区：self 与远端 node 互不影响', () => {
    const topology = {
      savedAt: Date.now(),
      windows: [{ id: '@1', index: 0, name: 'zsh', active: true, panes: [] }],
    };
    const selfPrefix = nodeStoragePrefix('self');
    const nodePrefix = nodeStoragePrefix('0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a');
    expect(selfPrefix).not.toBe(nodePrefix);

    writeTmuxTopology(selfPrefix, 'kept', topology);
    writeTmuxTopology(selfPrefix, 'deleted', topology);
    writeTmuxTopology(nodePrefix, 'deleted', topology);

    pruneTmuxTopologyCache(selfPrefix, new Set(['kept']));

    expect(Object.keys(readTmuxTopologyCache(selfPrefix))).toEqual(['kept']);
    // 另一个 node 的同名设备不受影响
    expect(readTmuxTopologyCache(nodePrefix).deleted).toBeDefined();

    clearTmuxTopologyCache(selfPrefix);
    clearTmuxTopologyCache(nodePrefix);
  });
});
