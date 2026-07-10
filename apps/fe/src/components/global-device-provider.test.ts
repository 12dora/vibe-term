import { describe, expect, test } from 'bun:test';
import { shouldEnsureRouteDeviceSubscription } from './global-device-provider';

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
