import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Device, EventDevicePayload, SiteSettings } from '@vibeterm/shared';

import {
  createDevice,
  getDeviceRuntimeStatus,
  getSiteSettings,
  updateDeviceRuntimeStatus,
} from '../db';
import { runMigrations } from '../db/migrate';
import { connectionAlertNotifier } from '../push/connection-alerts';
import type { ControlHealthEvent } from './control-health';
import {
  TMUX_BUSY_DEBOUNCE_MS,
  clearControlChannelError,
  considerTmuxBusyError,
  handleControlHealth,
  resetTmuxBusyIncidentsForTest,
  setTmuxBusyTimersForTest,
} from './runtime-error-alert';

const now = '2026-11-15T00:00:00.000Z';

function makeDevice(id: string): Device {
  return {
    id,
    name: id,
    type: 'local',
    session: 'vibeterm',
    authMode: 'auto',
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

type Scheduled = { fn: () => void; ms: number; cancelled: boolean };

function installFakeTimers() {
  const scheduled: Scheduled[] = [];
  setTmuxBusyTimersForTest({
    setTimeout: (fn, ms) => {
      const entry: Scheduled = { fn, ms, cancelled: false };
      scheduled.push(entry);
      return entry;
    },
    clearTimeout: (id) => {
      (id as Scheduled).cancelled = true;
    },
  });
  return {
    scheduled,
    firePending() {
      const entry = scheduled.find((item) => !item.cancelled);
      if (!entry) throw new Error('no live timer');
      entry.cancelled = true;
      entry.fn();
    },
  };
}

function health(deviceId: string, kind: ControlHealthEvent['kind']): ControlHealthEvent {
  return { kind, deviceId, headAgeMs: 12_000, lastActivityAgoMs: 800 };
}

beforeAll(() => {
  runMigrations();
});

describe('tmux_busy debounce and auto-clear', () => {
  const broadcasts: EventDevicePayload[] = [];
  let originalError: typeof console.error;

  beforeEach(() => {
    broadcasts.length = 0;
    originalError = console.error;
    console.error = () => {};
    connectionAlertNotifier.setSettingsProvider(settings);
    connectionAlertNotifier.setPersister((deviceId, lastError, lastErrorType) => {
      updateDeviceRuntimeStatus(deviceId, {
        lastSeenAt: new Date().toISOString(),
        lastError,
        lastErrorType,
      });
    });
    connectionAlertNotifier.setBroadcaster((_deviceId, payload) => {
      broadcasts.push(payload);
    });
  });

  afterEach(() => {
    console.error = originalError;
    resetTmuxBusyIncidentsForTest();
    setTmuxBusyTimersForTest(null);
    connectionAlertNotifier.setBroadcaster(null);
    connectionAlertNotifier.setSettingsProvider(() => getSiteSettings());
  });

  test('a single slow command does not raise until 15s', async () => {
    const device = makeDevice('r2151-busy-debounce');
    createDevice(device);
    const clock = installFakeTimers();
    const err = new Error('tmux control command timed out: send-keys -H -t %1 1b 5b');

    expect(considerTmuxBusyError(device.id, err)).toBe(true);
    await Promise.resolve();
    expect(broadcasts).toEqual([]);
    expect(getDeviceRuntimeStatus(device.id).lastErrorType).toBeNull();
    expect(clock.scheduled.map((item) => item.ms)).toEqual([TMUX_BUSY_DEBOUNCE_MS]);

    clock.firePending();
    await Promise.resolve();
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]?.errorType).toBe('tmux_busy');
    expect(broadcasts[0]?.rawMessage).toBe('tmux control command timed out: send-keys');
    expect(getDeviceRuntimeStatus(device.id).lastErrorType).toBe('tmux_busy');
  });

  test('supervisor and WS share one alert per incident', async () => {
    const device = makeDevice('r2151-busy-once');
    createDevice(device);
    const clock = installFakeTimers();
    const err = new Error('tmux control command timed out: send-keys');

    expect(considerTmuxBusyError(device.id, err)).toBe(true);
    expect(considerTmuxBusyError(device.id, err)).toBe(true);
    handleControlHealth(health(device.id, 'slow'));
    expect(clock.scheduled.filter((item) => !item.cancelled)).toHaveLength(1);

    clock.firePending();
    await Promise.resolve();
    expect(broadcasts.filter((item) => item.type === 'error')).toHaveLength(1);

    considerTmuxBusyError(device.id, err);
    expect(clock.scheduled.filter((item) => !item.cancelled)).toHaveLength(0);
    await Promise.resolve();
    expect(broadcasts.filter((item) => item.type === 'error')).toHaveLength(1);
  });

  test('stalled raises immediately without waiting for debounce', async () => {
    const device = makeDevice('r2151-busy-stalled');
    createDevice(device);
    installFakeTimers();
    handleControlHealth(health(device.id, 'stalled'));
    await Promise.resolve();
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]?.errorType).toBe('tmux_busy');
    expect(getDeviceRuntimeStatus(device.id).lastErrorType).toBe('tmux_busy');
  });

  test('recovered auto-clears tmux_busy and broadcasts reconnected', async () => {
    const device = makeDevice('r2151-busy-recovered');
    createDevice(device);
    installFakeTimers();
    handleControlHealth(health(device.id, 'stalled'));
    await Promise.resolve();
    expect(getDeviceRuntimeStatus(device.id).lastErrorType).toBe('tmux_busy');

    handleControlHealth(health(device.id, 'recovered'));
    expect(getDeviceRuntimeStatus(device.id).lastErrorType).toBeNull();
    expect(getDeviceRuntimeStatus(device.id).lastError).toBeNull();
    expect(broadcasts.map((item) => item.type)).toEqual(['error', 'reconnected']);
  });

  test('pending slow is cancelled on recovered and never alerts', async () => {
    const device = makeDevice('r2151-busy-cancel');
    createDevice(device);
    const clock = installFakeTimers();
    considerTmuxBusyError(device.id, new Error('tmux control command timed out: send-keys'));
    handleControlHealth(health(device.id, 'recovered'));
    expect(() => clock.firePending()).toThrow('no live timer');
    await Promise.resolve();
    expect(broadcasts).toEqual([]);
    expect(getDeviceRuntimeStatus(device.id).lastErrorType).toBeNull();
  });

  test('does not clear unrelated error types on recovered', async () => {
    const device = makeDevice('r2151-busy-keep-auth');
    createDevice(device);
    updateDeviceRuntimeStatus(device.id, {
      lastError: 'Authentication failed',
      lastErrorType: 'auth_failed',
    });
    handleControlHealth(health(device.id, 'recovered'));
    const status = getDeviceRuntimeStatus(device.id);
    expect(status.lastErrorType).toBe('auth_failed');
    expect(status.lastError).toBe('Authentication failed');
    expect(broadcasts).toEqual([]);
  });

  test('clears leftover unknown control-timeout lastError', () => {
    const device = makeDevice('r2151-busy-legacy-unknown');
    createDevice(device);
    updateDeviceRuntimeStatus(device.id, {
      lastError: 'tmux control command timed out: send-keys',
      lastErrorType: 'unknown',
    });
    clearControlChannelError(device.id);
    expect(getDeviceRuntimeStatus(device.id).lastErrorType).toBeNull();
    expect(broadcasts.map((item) => item.type)).toEqual(['reconnected']);
  });
});
