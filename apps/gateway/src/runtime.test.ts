import { afterEach, describe, expect, test } from 'bun:test';
import { isRelayOnly, parseVibeTermRoles } from './config';
import {
  type LiveStartGates,
  liveServicesEnabled,
  setLiveServicesEnabled,
} from './live-start-gates';
import { getMessagingRuntimeHooks } from './messaging/context';
import { ensureMessagingHooks, resetMessagingHooksIfLoaded } from './messaging/lazy-hooks';
import {
  type LiveGatewayStartDeps,
  shouldStartMessagingServices,
  startLiveGatewayServices,
} from './runtime';

afterEach(() => {
  resetMessagingHooksIfLoaded();
  setLiveServicesEnabled(false);
});

function gates(open: boolean, overrides: Partial<LiveStartGates> = {}): LiveStartGates {
  const value = () => open;
  return {
    telegram: value,
    weixin: value,
    agent: value,
    watch: value,
    tunnel: value,
    portMaps: value,
    ...overrides,
  };
}

function recordingDeps(calls: string[], roles: string, open: boolean): LiveGatewayStartDeps {
  const mark = (name: string) => async () => {
    calls.push(name);
  };
  return {
    roles: parseVibeTermRoles(roles),
    startLag: () => {
      calls.push('lag');
    },
    ensureLocale: mark('locale'),
    refreshTelegram: mark('telegram-refresh'),
    refreshWeixin: mark('weixin-refresh'),
    startPush: mark('push'),
    startAgent: mark('agent'),
    startWatch: mark('watch'),
    startTunnel: mark('tunnel'),
    loadTunnel: mark('tunnel-load'),
    startExportSweeper: () => {
      calls.push('export-sweeper');
    },
    startPortMaps: mark('portmaps'),
    sendOnline: mark('online'),
    gates: gates(open),
  };
}

describe('relay-only messaging gate', () => {
  test('isRelayOnly is true only for pure relay', () => {
    expect(isRelayOnly(parseVibeTermRoles('relay'))).toBe(true);
    expect(isRelayOnly(parseVibeTermRoles('relay,node'))).toBe(false);
    expect(isRelayOnly(parseVibeTermRoles('node'))).toBe(false);
    expect(isRelayOnly(parseVibeTermRoles('standalone'))).toBe(false);
    expect(isRelayOnly(parseVibeTermRoles(undefined))).toBe(false);
  });

  test('shouldStartMessagingServices skips only relay-only', () => {
    expect(shouldStartMessagingServices(parseVibeTermRoles('relay'))).toBe(false);
    expect(shouldStartMessagingServices(parseVibeTermRoles('relay,node'))).toBe(true);
    expect(shouldStartMessagingServices(parseVibeTermRoles('node'))).toBe(true);
    expect(shouldStartMessagingServices(parseVibeTermRoles(undefined))).toBe(true);
  });

  test('relay-only loads the site locale and only loads the tunnel when configured', async () => {
    const idle: string[] = [];
    await startLiveGatewayServices(recordingDeps(idle, 'relay', false));
    expect(idle).toEqual(['lag', 'locale']);
    expect(liveServicesEnabled()).toBe(false);

    const configured: string[] = [];
    await startLiveGatewayServices(recordingDeps(configured, 'relay', true));
    expect(configured).toEqual(['lag', 'locale', 'tunnel-load']);
  });

  test('configured node starts every subsystem in the original order', async () => {
    const calls: string[] = [];
    await startLiveGatewayServices(recordingDeps(calls, 'node', true));
    expect(calls).toEqual([
      'lag',
      'locale',
      'telegram-refresh',
      'weixin-refresh',
      'push',
      'agent',
      'watch',
      'tunnel',
      'export-sweeper',
      'portmaps',
      'online',
    ]);
    expect(liveServicesEnabled()).toBe(true);
  });

  test('unconfigured node keeps only push, export sweeper and online', async () => {
    const calls: string[] = [];
    await startLiveGatewayServices(recordingDeps(calls, 'node', false));
    expect(calls).toEqual(['lag', 'locale', 'push', 'export-sweeper', 'online']);
    expect(liveServicesEnabled()).toBe(true);
  });

  test('each gate controls only its own subsystem', async () => {
    const calls: string[] = [];
    const deps = recordingDeps(calls, 'relay,node', false);
    deps.gates = gates(false, { watch: () => true, portMaps: () => true });
    await startLiveGatewayServices(deps);
    expect(calls).toEqual([
      'lag',
      'locale',
      'push',
      'watch',
      'export-sweeper',
      'portmaps',
      'online',
    ]);
  });
});

describe('lazy messaging hooks', () => {
  test('live start arms hooks; registration waits for the first bot service load', async () => {
    await startLiveGatewayServices(recordingDeps([], 'node', false));
    expect(getMessagingRuntimeHooks().decideConfirmation).toBeUndefined();
    await ensureMessagingHooks();
    const hooks = getMessagingRuntimeHooks();
    expect(typeof hooks.getUplinkStatus).toBe('function');
    expect(typeof hooks.listMeshNodes).toBe('function');
    expect(typeof hooks.getDeviceTree).toBe('function');
    expect(typeof hooks.capturePane).toBe('function');
    expect(typeof hooks.sendKeys).toBe('function');
    expect(typeof hooks.decideConfirmation).toBe('function');
  });

  test('relay-only still arms hooks', async () => {
    await startLiveGatewayServices(recordingDeps([], 'relay', false));
    await ensureMessagingHooks();
    expect(typeof getMessagingRuntimeHooks().decideConfirmation).toBe('function');
  });

  test('hooks stay unregistered before live start and after reset', async () => {
    await ensureMessagingHooks();
    expect(getMessagingRuntimeHooks().decideConfirmation).toBeUndefined();
  });
});
