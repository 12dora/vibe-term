import { afterEach, describe, expect, test } from 'bun:test';
import { isRelayOnly, parseTmexRoles } from './config';
import { getMessagingRuntimeHooks, resetMessagingRuntime } from './messaging/context';
import { setMessagingMeshRuntime } from './messaging/runtime-hooks';
import { shouldStartMessagingServices, startLiveGatewayServices } from './runtime';

afterEach(() => {
  resetMessagingRuntime();
  setMessagingMeshRuntime(null);
});

describe('relay-only messaging gate', () => {
  test('isRelayOnly is true only for pure relay', () => {
    expect(isRelayOnly(parseTmexRoles('relay'))).toBe(true);
    expect(isRelayOnly(parseTmexRoles('relay,node'))).toBe(false);
    expect(isRelayOnly(parseTmexRoles('node'))).toBe(false);
    expect(isRelayOnly(parseTmexRoles('hub,node'))).toBe(false);
    expect(isRelayOnly(parseTmexRoles('standalone'))).toBe(false);
    expect(isRelayOnly(parseTmexRoles(undefined))).toBe(false);
  });

  test('shouldStartMessagingServices skips only relay-only', () => {
    expect(shouldStartMessagingServices(parseTmexRoles('relay'))).toBe(false);
    expect(shouldStartMessagingServices(parseTmexRoles('relay,node'))).toBe(true);
    expect(shouldStartMessagingServices(parseTmexRoles('node'))).toBe(true);
    expect(shouldStartMessagingServices(parseTmexRoles('hub,node'))).toBe(true);
    expect(shouldStartMessagingServices(parseTmexRoles(undefined))).toBe(true);
  });

  test('startLiveGatewayServices skips telegram/weixin/watch/online on relay-only', async () => {
    const calls: string[] = [];
    const mark = (name: string) => async () => {
      calls.push(name);
    };
    await startLiveGatewayServices({
      roles: parseTmexRoles('relay'),
      startLag: () => {
        calls.push('lag');
      },
      refreshTelegram: mark('telegram-refresh'),
      refreshWeixin: mark('weixin-refresh'),
      startPush: mark('push'),
      startAgent: mark('agent'),
      startWatch: mark('watch'),
      startTunnel: mark('tunnel'),
      sendOnline: mark('online'),
    });
    expect(calls).toEqual(['lag', 'push', 'agent', 'tunnel']);
  });

  test('startLiveGatewayServices starts messaging on node/hub roles', async () => {
    const calls: string[] = [];
    const mark = (name: string) => async () => {
      calls.push(name);
    };
    await startLiveGatewayServices({
      roles: parseTmexRoles('hub,node'),
      startLag: () => {
        calls.push('lag');
      },
      refreshTelegram: mark('telegram-refresh'),
      refreshWeixin: mark('weixin-refresh'),
      startPush: mark('push'),
      startAgent: mark('agent'),
      startWatch: mark('watch'),
      startTunnel: mark('tunnel'),
      sendOnline: mark('online'),
    });
    expect(calls).toEqual([
      'lag',
      'telegram-refresh',
      'weixin-refresh',
      'push',
      'agent',
      'watch',
      'tunnel',
      'online',
    ]);
  });

  test('startLiveGatewayServices registers messaging hooks before telegram refresh', async () => {
    const seen: string[] = [];
    await startLiveGatewayServices({
      roles: parseTmexRoles('node'),
      startLag: () => {
        seen.push('lag');
      },
      refreshTelegram: async () => {
        const hooks = getMessagingRuntimeHooks();
        expect(typeof hooks.getUplinkStatus).toBe('function');
        expect(typeof hooks.listMeshNodes).toBe('function');
        expect(typeof hooks.getDeviceTree).toBe('function');
        expect(typeof hooks.capturePane).toBe('function');
        expect(typeof hooks.sendKeys).toBe('function');
        expect(typeof hooks.decideConfirmation).toBe('function');
        seen.push('telegram-refresh');
      },
      refreshWeixin: async () => {
        seen.push('weixin-refresh');
      },
      startPush: async () => {
        seen.push('push');
      },
      startAgent: async () => {
        seen.push('agent');
      },
      startWatch: async () => {
        seen.push('watch');
      },
      startTunnel: async () => {
        seen.push('tunnel');
      },
      sendOnline: async () => {
        seen.push('online');
      },
    });
    expect(seen[0]).toBe('lag');
    expect(seen[1]).toBe('telegram-refresh');
    const hooks = getMessagingRuntimeHooks();
    expect(hooks.getDeviceTree).toBeDefined();
    expect(hooks.capturePane).toBeDefined();
    expect(hooks.sendKeys).toBeDefined();
    expect(hooks.decideConfirmation).toBeDefined();
    expect(hooks.getUplinkStatus).toBeDefined();
    expect(hooks.listMeshNodes).toBeDefined();
  });

  test('relay-only still registers hooks while skipping telegram/weixin', async () => {
    await startLiveGatewayServices({
      roles: parseTmexRoles('relay'),
      startLag: () => {},
      refreshTelegram: async () => {
        throw new Error('telegram must not start');
      },
      refreshWeixin: async () => {
        throw new Error('weixin must not start');
      },
      startPush: async () => {},
      startAgent: async () => {},
      startWatch: async () => {
        throw new Error('watch must not start');
      },
      startTunnel: async () => {},
      sendOnline: async () => {
        throw new Error('online must not start');
      },
    });
    expect(typeof getMessagingRuntimeHooks().decideConfirmation).toBe('function');
  });
});
