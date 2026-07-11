import { beforeEach, describe, expect, test } from 'bun:test';
import type { Device, SiteSettings } from '@tmex/shared';
import { ConnectionAlertNotifier } from './connection-alerts';

function makeDevice(id: string): Device {
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
    updatedAt: '2026-04-18T00:00:00Z',
  };
}

function makeNotifier() {
  const notifier = new ConnectionAlertNotifier();
  const persisted: Array<{ deviceId: string; message: string; type: string }> = [];
  const broadcasts: Array<{ deviceId: string; errorType?: string }> = [];
  const telegrams: string[] = [];

  notifier.setSettingsProvider(() => makeSettings());
  notifier.setPersister((deviceId, message, type) => {
    persisted.push({ deviceId, message, type });
  });
  notifier.setBroadcaster((deviceId, payload) => {
    broadcasts.push({ deviceId, errorType: payload.errorType });
  });
  notifier.setTelegramSender(async (text) => {
    telegrams.push(text);
  });

  return { notifier, persisted, broadcasts, telegrams };
}

describe('ConnectionAlertNotifier', () => {
  let notifier: ReturnType<typeof makeNotifier>;

  beforeEach(() => {
    notifier = makeNotifier();
  });

  test('classifies auth error and persists + broadcasts + sends telegram', async () => {
    const device = makeDevice('d1');
    const err = new Error('All configured authentication methods failed');
    const result = await notifier.notifier.notify({ device, error: err, source: 'connect' });

    expect(result.errorType).toBe('auth_failed');
    expect(notifier.persisted).toHaveLength(1);
    expect(notifier.persisted[0].type).toBe('auth_failed');
    expect(notifier.broadcasts).toHaveLength(1);
    expect(notifier.broadcasts[0].errorType).toBe('auth_failed');
    expect(notifier.telegrams).toHaveLength(1);
  });

  test('throttles telegram within same deviceId:errorType for 5 minutes', async () => {
    const device = makeDevice('d1');
    const err = new Error('Permission denied');

    await notifier.notifier.notify({ device, error: err, source: 'connect' });
    await notifier.notifier.notify({ device, error: err, source: 'connect' });
    await notifier.notifier.notify({ device, error: err, source: 'connect' });

    expect(notifier.telegrams).toHaveLength(1);
    expect(notifier.broadcasts).toHaveLength(3);
    expect(notifier.persisted).toHaveLength(3);
  });

  test('errorType switch re-sends telegram immediately', async () => {
    const device = makeDevice('d1');

    await notifier.notifier.notify({
      device,
      error: new Error('Permission denied'),
      source: 'connect',
    });
    await notifier.notifier.notify({
      device,
      error: new Error('ECONNREFUSED 10.0.0.1:22'),
      source: 'connect',
    });

    expect(notifier.telegrams).toHaveLength(2);
  });

  test('per-device throttle is independent', async () => {
    const a = makeDevice('a');
    const b = makeDevice('b');
    const err = new Error('Permission denied');

    await notifier.notifier.notify({ device: a, error: err, source: 'connect' });
    await notifier.notifier.notify({ device: b, error: err, source: 'connect' });

    expect(notifier.telegrams).toHaveLength(2);
  });

  test('silentTelegram suppresses telegram but still persists + broadcasts', async () => {
    const device = makeDevice('d1');
    const err = new Error('ECONNREFUSED');

    await notifier.notifier.notify({
      device,
      error: err,
      source: 'probe',
      silentTelegram: true,
    });

    expect(notifier.telegrams).toHaveLength(0);
    expect(notifier.persisted).toHaveLength(1);
    expect(notifier.broadcasts).toHaveLength(1);
  });

  test('classifies connection closed sentinel', async () => {
    const device = makeDevice('d1');
    const err = new Error('ssh_connection_closed');
    const result = await notifier.notifier.notify({ device, error: err, source: 'close' });
    expect(result.errorType).toBe('connection_closed');
  });

  test('persists raw error alongside the friendly message', async () => {
    const device = makeDevice('d1');
    const err = new Error('getaddrinfo ENOTFOUND /users/tester/.ssh/config');
    const result = await notifier.notifier.notify({ device, error: err, source: 'connect' });

    expect(result.errorType).toBe('host_not_found');
    expect(result.rawMessage).toBe('getaddrinfo ENOTFOUND /users/tester/.ssh/config');
    expect(notifier.persisted).toHaveLength(1);
    // 持久化文案应同时包含归类后的友好文案与真实错误
    expect(notifier.persisted[0].message).toBe(`${result.message}\n${result.rawMessage}`);
    expect(notifier.persisted[0].message).toContain('getaddrinfo ENOTFOUND');
  });

  test('does not duplicate raw when friendly message already embeds it (unknown category)', async () => {
    const device = makeDevice('d1');
    const rawText = 'some weird unclassified failure';
    const result = await notifier.notifier.notify({
      device,
      error: new Error(rawText),
      source: 'connect',
    });

    expect(result.errorType).toBe('unknown');
    // unknown 文案模板已内嵌 raw（"Connection failed: {{message}}"），不应再拼一次
    expect(notifier.persisted[0].message).toBe(result.message);
    const occurrences = notifier.persisted[0].message.split(rawText).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('ConnectionAlertNotifier event bridge', () => {
  function makeBridgedNotifier() {
    const base = makeNotifier();
    const events: Array<{ eventType: string; event: Record<string, unknown> }> = [];
    base.notifier.setEventEmitter((eventType, event) => {
      events.push({ eventType, event: event as unknown as Record<string, unknown> });
    });
    return { ...base, events };
  }

  test('maps connection-level errors to device_disconnect with full event shape', async () => {
    const { notifier, events } = makeBridgedNotifier();
    const device = makeDevice('d1');
    await notifier.notify({ device, error: new Error('ssh_connection_closed'), source: 'close' });

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('device_disconnect');
    const event = events[0].event as {
      site: { name: string; url: string };
      device: { id: string; name: string };
      tmux: { sessionName?: string };
      payload: { message?: string };
    };
    expect(event.site.name).toBe('tmex');
    expect(event.device.id).toBe('d1');
    expect(event.tmux.sessionName).toBe('tmex');
    expect(typeof event.payload.message).toBe('string');
  });

  test('maps tmux_unavailable to device_tmux_missing', async () => {
    const { notifier, events } = makeBridgedNotifier();
    await notifier.notify({
      device: makeDevice('d1'),
      error: new Error('remote tmux unavailable: not installed'),
      source: 'probe',
    });
    expect(events.map((e) => e.eventType)).toEqual(['device_tmux_missing']);
  });

  test.each([
    ['ENETUNREACH', 'device_disconnect'],
    ['connection refused', 'device_disconnect'],
    ['ETIMEDOUT', 'device_disconnect'],
    ['host not found', 'device_disconnect'],
    ['handshake failed', 'device_disconnect'],
  ])('maps %s to %s', async (raw, expected) => {
    const { notifier, events } = makeBridgedNotifier();
    await notifier.notify({ device: makeDevice('d1'), error: new Error(raw), source: 'connect' });
    expect(events.map((e) => e.eventType)).toEqual([expected]);
  });

  test('auth/config/unknown errors do not bridge', async () => {
    const { notifier, events } = makeBridgedNotifier();
    for (const raw of ['permission denied', 'ssh_config_ref_not_supported', 'weird failure']) {
      await notifier.notify({ device: makeDevice('d1'), error: new Error(raw), source: 'close' });
    }
    expect(events).toHaveLength(0);
  });

  test('runtime source is gated off', async () => {
    const { notifier, events } = makeBridgedNotifier();
    await notifier.notify({
      device: makeDevice('d1'),
      error: new Error('ssh_connection_closed'),
      source: 'runtime',
    });
    expect(events).toHaveLength(0);
  });

  test('throttles repeated events per device+type within the window', async () => {
    const { notifier, events } = makeBridgedNotifier();
    const device = makeDevice('d1');
    await notifier.notify({ device, error: new Error('ssh_connection_closed'), source: 'close' });
    await notifier.notify({ device, error: new Error('connection closed'), source: 'close' });
    expect(events).toHaveLength(1);

    // 不同事件类型与不同设备不受影响
    await notifier.notify({
      device,
      error: new Error('remote tmux unavailable: x'),
      source: 'probe',
    });
    await notifier.notify({
      device: makeDevice('d2'),
      error: new Error('ssh_connection_closed'),
      source: 'close',
    });
    expect(events.map((e) => e.eventType)).toEqual([
      'device_disconnect',
      'device_tmux_missing',
      'device_disconnect',
    ]);
  });

  test('clear() resets the bridge throttle for the device', async () => {
    const { notifier, events } = makeBridgedNotifier();
    const device = makeDevice('d1');
    await notifier.notify({ device, error: new Error('ssh_connection_closed'), source: 'close' });
    notifier.clear(device.id);
    await notifier.notify({ device, error: new Error('ssh_connection_closed'), source: 'close' });
    expect(events).toHaveLength(2);
  });

  test('skips device_disconnect when the connection already emitted session_closed', async () => {
    const { notifier, events } = makeBridgedNotifier();
    await notifier.notify({
      device: makeDevice('d1'),
      error: new Error('ssh_connection_closed'),
      source: 'close',
      sessionClosedEmitted: true,
    });
    expect(events).toHaveLength(0);

    // device_tmux_missing 不受该守卫影响
    await notifier.notify({
      device: makeDevice('d1'),
      error: new Error('remote tmux unavailable: x'),
      source: 'probe',
      sessionClosedEmitted: true,
    });
    expect(events.map((e) => e.eventType)).toEqual(['device_tmux_missing']);
  });

  // 抑制信号必须来自连接实例的显式标志：持久化的 tmuxAvailable 状态位被
  // error handler、连接失败路径、无记录设备缺省值等大量非 session-gone 路径
  // 写成 false，不可据其抑制（否则错误型断开与新设备连接失败全部漏报）。
  test('emits device_disconnect on error-style close even after runtime status was marked unavailable', async () => {
    const { notifier, events } = makeBridgedNotifier();
    const device = makeDevice('d1');
    // 模拟 error handler 先持久化 tmuxAvailable=false（runtime source 不桥接，但会写状态）
    await notifier.notify({
      device,
      error: new Error('read ECONNRESET'),
      source: 'runtime',
      silentTelegram: true,
    });
    expect(events).toHaveLength(0);
    // 随后连接关闭：session 并未 gone（sessionClosedEmitted=false），必须发出 device_disconnect
    await notifier.notify({
      device,
      error: new Error('ssh_connection_closed'),
      source: 'close',
      sessionClosedEmitted: false,
    });
    expect(events.map((e) => e.eventType)).toEqual(['device_disconnect']);
  });

  test('emits device_disconnect for a brand-new device failing to connect (no prior runtime status)', async () => {
    const { notifier, events } = makeBridgedNotifier();
    await notifier.notify({
      device: makeDevice('fresh'),
      error: new Error('ECONNREFUSED 10.0.0.9:22'),
      source: 'connect',
    });
    expect(events.map((e) => e.eventType)).toEqual(['device_disconnect']);
  });

  test('settings provider failure does not consume the bridge throttle window', async () => {
    const { notifier, events } = makeBridgedNotifier();
    const device = makeDevice('d1');
    let settingsBroken = true;
    notifier.setSettingsProvider(() => {
      if (settingsBroken) {
        throw new Error('settings unavailable');
      }
      return makeSettings();
    });

    await notifier.notify({ device, error: new Error('ssh_connection_closed'), source: 'close' });
    expect(events).toHaveLength(0);

    settingsBroken = false;
    await notifier.notify({ device, error: new Error('ssh_connection_closed'), source: 'close' });
    expect(events.map((e) => e.eventType)).toEqual(['device_disconnect']);
  });

  test('successful emit lazily sweeps expired bridge throttle keys for the same device only', async () => {
    const { notifier, events } = makeBridgedNotifier();
    const bridgeMap = (notifier as unknown as { bridgeThrottleMap: Map<string, number> })
      .bridgeThrottleMap;
    const expired = Date.now() - 5 * 60 * 1000 - 1;
    bridgeMap.set('d1:device_tmux_missing', expired);
    bridgeMap.set('d2:device_disconnect', expired);

    await notifier.notify({
      device: makeDevice('d1'),
      error: new Error('ssh_connection_closed'),
      source: 'close',
    });

    expect(events).toHaveLength(1);
    expect(bridgeMap.has('d1:device_disconnect')).toBe(true);
    expect(bridgeMap.has('d1:device_tmux_missing')).toBe(false);
    expect(bridgeMap.has('d2:device_disconnect')).toBe(true);
  });
});
