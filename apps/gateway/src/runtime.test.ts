import { describe, expect, test } from 'bun:test';
import { isRelayOnly, parseTmexRoles } from './config';
import { shouldStartMessagingServices, startLiveGatewayServices } from './runtime';

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
});
