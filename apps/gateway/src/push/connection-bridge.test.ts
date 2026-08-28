import { describe, expect, test } from 'bun:test';
import type { Device, SiteSettings } from '@tmex/shared';
import {
  buildConnectionBridgeEvent,
  isWithinThrottleWindow,
  mapErrorTypeToBridgeEvent,
  resolveConnectionBridgeEvent,
  sweepExpiredThrottleKeys,
} from './connection-bridge';

function makeDevice(id = 'd1'): Device {
  return {
    id,
    name: `dev-${id}`,
    type: 'ssh',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    session: 'tmex',
    authMode: 'password',
    sortOrder: 0,
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-18T00:00:00Z',
  };
}

function makeSettings(): SiteSettings {
  return {
    siteName: 'tmex',
    siteUrl: 'https://tmex.example.com',
    bellThrottleSeconds: 6,
    notificationThrottleSeconds: 3,
    enableBrowserNotificationToast: true,
    enableNotificationPush: true,
    enableBellPush: true,
    enableBellSound: true,
    sshReconnectMaxRetries: 2,
    sshReconnectDelaySeconds: 1,
    language: 'zh_CN',
    theme: 'dark',
    disabledNotificationChannels: [],
    updatedAt: '2026-04-18T00:00:00Z',
  };
}

describe('mapErrorTypeToBridgeEvent', () => {
  test.each([
    ['tmux_unavailable', 'device_tmux_missing'],
    ['connection_closed', 'device_disconnect'],
    ['network_unreachable', 'device_disconnect'],
    ['connection_refused', 'device_disconnect'],
    ['timeout', 'device_disconnect'],
    ['host_not_found', 'device_disconnect'],
    ['handshake_failed', 'device_disconnect'],
    ['auth_failed', null],
    ['unknown', null],
    ['agent_unavailable', null],
  ] as const)('%s → %s', (errorType, expected) => {
    expect(mapErrorTypeToBridgeEvent(errorType)).toBe(expected);
  });
});

describe('resolveConnectionBridgeEvent', () => {
  test('runtime 来源一律不桥接', () => {
    expect(resolveConnectionBridgeEvent('runtime', 'connection_closed', false)).toBeNull();
    expect(resolveConnectionBridgeEvent('runtime', 'tmux_unavailable', false)).toBeNull();
  });

  test.each(['close', 'connect', 'probe'] as const)('%s 来源按错误类型映射', (source) => {
    expect(resolveConnectionBridgeEvent(source, 'connection_closed', false)).toBe(
      'device_disconnect'
    );
    expect(resolveConnectionBridgeEvent(source, 'tmux_unavailable', false)).toBe(
      'device_tmux_missing'
    );
    expect(resolveConnectionBridgeEvent(source, 'auth_failed', false)).toBeNull();
  });

  test('sessionClosedEmitted 抑制 device_disconnect 但不抑制 tmux missing', () => {
    expect(resolveConnectionBridgeEvent('close', 'connection_closed', true)).toBeNull();
    expect(resolveConnectionBridgeEvent('probe', 'tmux_unavailable', true)).toBe(
      'device_tmux_missing'
    );
  });
});

describe('buildConnectionBridgeEvent', () => {
  test('组装 site/device/tmux/payload，session 缺省 tmex', () => {
    const event = buildConnectionBridgeEvent(makeDevice(), makeSettings(), 'down');
    expect(event.site).toEqual({ name: 'tmex', url: 'https://tmex.example.com' });
    expect(event.device).toEqual({
      id: 'd1',
      name: 'dev-d1',
      type: 'ssh',
      host: '10.0.0.1',
    });
    expect(event.tmux).toEqual({ sessionName: 'tmex' });
    expect(event.payload).toEqual({ message: 'down' });
  });

  test('空白 session 回退 tmex', () => {
    const device = makeDevice();
    device.session = '  ';
    expect(buildConnectionBridgeEvent(device, makeSettings(), 'x').tmux?.sessionName).toBe('tmex');
  });
});

describe('throttle helpers', () => {
  test('isWithinThrottleWindow 在窗口内为 true', () => {
    const now = 10_000;
    expect(isWithinThrottleWindow(now - 100, now, 1000)).toBe(true);
    expect(isWithinThrottleWindow(now - 1000, now, 1000)).toBe(false);
    expect(isWithinThrottleWindow(undefined, now, 1000)).toBe(false);
  });

  test('sweepExpiredThrottleKeys 只清同设备过期键', () => {
    const map = new Map<string, number>([
      ['d1:device_disconnect', 9000],
      ['d1:device_tmux_missing', 0],
      ['d2:device_disconnect', 0],
    ]);
    sweepExpiredThrottleKeys(map, 'd1', 'd1:device_disconnect', 10_000, 1000);
    expect([...map.keys()].sort()).toEqual(['d1:device_disconnect', 'd2:device_disconnect']);
  });
});
