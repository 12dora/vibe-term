import { describe, expect, test } from 'bun:test';
import { nodeAppPath } from '@tmex/api-client';
import { routeDeviceId, shouldEnsureRouteDeviceSubscription } from './global-device-provider';

const selfAppPath = (path: string) => nodeAppPath('self', path);
const nodeAAppPath = (path: string) => nodeAppPath('0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a', path);

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
