import { beforeAll, describe, expect, test } from 'bun:test';
import type { Device, EventDevicePayload, SiteSettings } from '@vibeterm/shared';

import {
  createDevice,
  getDeviceRuntimeStatus,
  getSiteSettings,
  updateDeviceRuntimeStatus,
} from '../db';
import { runMigrations } from '../db/migrate';
import { connectionAlertNotifier } from '../push/connection-alerts';
import { PushSupervisor } from '../push/supervisor';
import type { DeviceSessionRuntime, DeviceSessionRuntimeListener } from './device-session-runtime';
import { SshExternalTmuxConnection } from './ssh-external-connection';
import { TmuxCommandFailedError } from './tmux-command-error';

const now = '2026-09-18T00:00:00.000Z';
const FAILURE = 'error connecting to /tmp/tmux-1000/default (No such file or directory)';

function sshDevice(id: string): Device {
  return {
    id,
    name: id,
    type: 'ssh',
    host: 'example.com',
    port: 22,
    username: 'alice',
    authMode: 'password',
    passwordEnc: 'encrypted-password',
    session: 'vibeterm',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function settings(): SiteSettings {
  return {
    siteName: 'VibeTerm',
    siteUrl: 'https://vibeterm.example.com',
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
    updatedAt: now,
  };
}

class ReportingSshConnection extends SshExternalTmuxConnection {
  reportFailure(message: string): void {
    this.reportTmuxCommandFailure(message);
  }
}

function mockRuntime(subscribe: DeviceSessionRuntime['subscribe']): DeviceSessionRuntime {
  return {
    async connect() {},
    subscribe,
    requestSnapshot() {},
    disconnect() {},
    sessionClosedEmitted: false,
  } as DeviceSessionRuntime;
}

beforeAll(() => {
  runMigrations();
});

// SSH 侧过去只写 lastError：一次性命令失败去重后，前端既收不到 error 事件，
// 刷新时 hydrateDeviceErrors 也因缺 lastErrorType 不显示横幅。必须与本机一样走连接告警。
describe('SSH 一次性 tmux 命令失败的上报', () => {
  test('reportTmuxCommandFailure 发告警并落 lastErrorType；onError 去重后仍只有一条设备错误', async () => {
    const device = sshDevice('r57-ssh-runtime-error');
    createDevice(device);
    const events: EventDevicePayload[] = [];
    const originalError = console.error;
    console.error = () => {};
    connectionAlertNotifier.setSettingsProvider(settings);
    connectionAlertNotifier.setPersister((deviceId, friendlyMessage, errorType) => {
      updateDeviceRuntimeStatus(deviceId, {
        lastSeenAt: new Date().toISOString(),
        lastError: friendlyMessage,
        lastErrorType: errorType,
      });
    });
    connectionAlertNotifier.setBroadcaster((_deviceId, payload) => {
      events.push(payload);
    });

    const attached: { listener: DeviceSessionRuntimeListener | null } = { listener: null };
    const supervisor = new PushSupervisor({
      deps: {
        listDevices: () => [device],
        getDevice: () => device,
        getSettings: settings,
        acquireRuntime: async () =>
          mockRuntime((next) => {
            attached.listener = next;
            return () => {
              attached.listener = null;
            };
          }),
        releaseRuntime: async () => {},
      },
    });

    try {
      await supervisor.start();
      const connection = new ReportingSshConnection(
        {
          deviceId: device.id,
          onEvent: () => {},
          onTerminalOutput: () => {},
          onTerminalHistory: () => {},
          onSnapshot: () => {},
          onError: () => {},
          onClose: () => {},
        },
        { getDevice: () => device }
      );

      connection.reportFailure(FAILURE);
      await new Promise((resolve) => setTimeout(resolve, 0));

      // 上游已上报：supervisor 的 onError 不再发第二条。
      attached.listener?.onError?.(new TmuxCommandFailedError(FAILURE));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events.map((event) => event.type)).toEqual(['error']);
      expect(events[0]?.rawMessage).toBe(FAILURE);
      const status = getDeviceRuntimeStatus(device.id);
      expect(status.lastError).toContain(FAILURE);
      expect(status.lastErrorType).toBeTruthy();
    } finally {
      console.error = originalError;
      await supervisor.stopAll();
      connectionAlertNotifier.setBroadcaster(null);
      connectionAlertNotifier.setSettingsProvider(() => getSiteSettings());
      connectionAlertNotifier.clear(device.id);
    }
  });
});
