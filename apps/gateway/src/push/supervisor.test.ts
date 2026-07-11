import { describe, expect, test } from 'bun:test';
import type { Device, SiteSettings, StateSnapshotPayload } from '@tmex/shared';
import type { DeviceSessionRuntimeListener } from '../tmux-client/device-session-runtime';
import { PushSupervisor } from './supervisor';

const now = '2026-02-11T00:00:00.000Z';

function createDevice(id: string): Device {
  return {
    id,
    name: id,
    type: 'local',
    session: 'tmex',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function createSettings(): SiteSettings {
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
    updatedAt: now,
  };
}

describe('PushSupervisor', () => {
  test('start should acquire all runtimes and request snapshots', async () => {
    const devices = [createDevice('d1'), createDevice('d2')];
    const acquireCalls: string[] = [];
    const snapshotCalls: string[] = [];

    const supervisor = new PushSupervisor({
      deps: {
        listDevices: () => devices,
        getDevice: (deviceId) => devices.find((item) => item.id === deviceId) ?? null,
        getSettings: () => createSettings(),
        acquireRuntime: async (deviceId) => {
          acquireCalls.push(deviceId);

          return {
            async connect() {},
            subscribe() {
              return () => {};
            },
            requestSnapshot() {
              snapshotCalls.push(deviceId);
            },
            disconnect() {},
          } as any;
        },
        releaseRuntime: async () => {},
      },
    });

    await supervisor.start();

    expect(acquireCalls.sort()).toEqual(['d1', 'd2']);
    expect(snapshotCalls.sort()).toEqual(['d1', 'd2']);

    await supervisor.stopAll();
  });

  test('remove should release existing runtime', async () => {
    const devices = [createDevice('d1')];
    const released: string[] = [];

    const supervisor = new PushSupervisor({
      deps: {
        listDevices: () => devices,
        getDevice: (deviceId) => devices.find((item) => item.id === deviceId) ?? null,
        getSettings: () => createSettings(),
        acquireRuntime: async () =>
          ({
            async connect() {},
            subscribe() {
              return () => {};
            },
            requestSnapshot() {},
            disconnect() {},
          }) as any,
        releaseRuntime: async (deviceId) => {
          released.push(deviceId);
        },
      },
    });

    await supervisor.start();
    supervisor.remove('d1');

    expect(released).toEqual(['d1']);
    await supervisor.stopAll();
  });

  test('bell event should notify with resolved pane context', async () => {
    const device = createDevice('d1');
    const notifications: Array<{ paneId?: string; windowId?: string; paneUrl?: string }> = [];
    let listener: DeviceSessionRuntimeListener | null = null;

    const supervisor = new PushSupervisor({
      deps: {
        listDevices: () => [device],
        getDevice: () => device,
        getSettings: () => createSettings(),
        acquireRuntime: async () =>
          ({
            subscribe(next: DeviceSessionRuntimeListener) {
              listener = next;
              return () => {
                listener = null;
              };
            },
            async connect() {},
            requestSnapshot() {},
            disconnect() {},
          }) as any,
        releaseRuntime: async () => {},
        async notifyBell(context) {
          notifications.push({
            paneId: context.bell.paneId,
            windowId: context.bell.windowId,
            paneUrl: context.bell.paneUrl,
          });
        },
      },
    });

    await supervisor.start();

    const snapshot: StateSnapshotPayload = {
      deviceId: device.id,
      session: {
        id: '$1',
        name: 'tmex',
        windows: [
          {
            id: '@1',
            name: 'main',
            index: 0,
            active: true,
            panes: [
              {
                id: '%1',
                windowId: '@1',
                index: 0,
                active: true,
                width: 80,
                height: 24,
              },
            ],
          },
        ],
      },
    };

    listener?.onSnapshot?.(snapshot);
    listener?.onEvent?.({ type: 'bell', data: { paneId: '%1' } });

    expect(notifications).toEqual([
      {
        paneId: '%1',
        windowId: '@1',
        paneUrl: 'https://tmex.example.com/devices/d1/windows/%401/panes/%251',
      },
    ]);

    await supervisor.stopAll();
  });

  test('notification event should notify with resolved pane context and payload', async () => {
    const device = createDevice('d2');
    const notifications: Array<{
      paneId?: string;
      windowId?: string;
      paneUrl?: string;
      source: string;
      title?: string;
      body: string;
    }> = [];
    let listener: DeviceSessionRuntimeListener | null = null;

    const supervisor = new PushSupervisor({
      deps: {
        listDevices: () => [device],
        getDevice: () => device,
        getSettings: () => createSettings(),
        acquireRuntime: async () =>
          ({
            subscribe(next: DeviceSessionRuntimeListener) {
              listener = next;
              return () => {
                listener = null;
              };
            },
            async connect() {},
            requestSnapshot() {},
            disconnect() {},
          }) as any,
        releaseRuntime: async () => {},
        async notifyNotification(context) {
          notifications.push({
            paneId: context.notification.paneId,
            windowId: context.notification.windowId,
            paneUrl: context.notification.paneUrl,
            source: context.notification.source,
            title: context.notification.title,
            body: context.notification.body,
          });
        },
      },
    });

    await supervisor.start();

    const snapshot: StateSnapshotPayload = {
      deviceId: device.id,
      session: {
        id: '$1',
        name: 'tmex',
        windows: [
          {
            id: '@1',
            name: 'main',
            index: 0,
            active: true,
            panes: [
              {
                id: '%1',
                windowId: '@1',
                index: 0,
                active: true,
                width: 80,
                height: 24,
              },
            ],
          },
        ],
      },
    };

    listener?.onSnapshot?.(snapshot);
    listener?.onEvent?.({
      type: 'notification',
      data: {
        paneId: '%1',
        source: 'osc777',
        title: 'Build finished',
        body: 'All 42 tests passed',
      },
    });

    expect(notifications).toEqual([
      {
        paneId: '%1',
        windowId: '@1',
        paneUrl: 'https://tmex.example.com/devices/d2/windows/%401/panes/%251',
        source: 'osc777',
        title: 'Build finished',
        body: 'All 42 tests passed',
      },
    ]);

    await supervisor.stopAll();
  });

  // 断开告警桥的双发抑制信号来自连接实例的显式标志：supervisor 必须把
  // runtime.sessionClosedEmitted 透传给桥，不依赖任何持久化状态位。
  test.each([
    [false, ['device_disconnect']],
    [true, []],
  ])(
    'close with sessionClosedEmitted=%p bridges %p',
    async (sessionClosedEmitted, expectedEvents) => {
      const device = createDevice(`close-${String(sessionClosedEmitted)}`);
      let listener: DeviceSessionRuntimeListener | null = null;
      const events: string[] = [];
      const { connectionAlertNotifier } = await import('./connection-alerts');
      connectionAlertNotifier.setEventEmitter((eventType) => {
        events.push(eventType);
      });
      connectionAlertNotifier.setSettingsProvider(() => createSettings());
      connectionAlertNotifier.setPersister(() => {});
      connectionAlertNotifier.setBroadcaster(() => {});
      connectionAlertNotifier.setTelegramSender(async () => {});

      const supervisor = new PushSupervisor({
        deps: {
          listDevices: () => [device],
          getDevice: () => device,
          getSettings: () => createSettings(),
          acquireRuntime: async () =>
            ({
              sessionClosedEmitted,
              subscribe(next: DeviceSessionRuntimeListener) {
                listener = next;
                return () => {
                  listener = null;
                };
              },
              async connect() {},
              requestSnapshot() {},
              disconnect() {},
            }) as any,
          releaseRuntime: async () => {},
        },
      });

      try {
        await supervisor.start();
        listener?.onClose?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(events).toEqual(expectedEvents);
      } finally {
        await supervisor.stopAll();
        connectionAlertNotifier.setEventEmitter(null);
        connectionAlertNotifier.clear(device.id);
      }
    }
  );
});
