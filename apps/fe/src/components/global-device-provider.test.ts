import { describe, expect, test } from 'bun:test';
import { ApiClient, nodeAppPath } from '@tmex/api-client';
import { devicesQueryOptions, routeDeviceId } from './global-device-provider';

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
