import { describe, expect, test } from 'bun:test';
import {
  type RelayDialContext,
  isLoopbackRelayDial,
  relayDialContextFromEnv,
  relayDialContextFromRuntime,
  relayTlsCaForDial,
  resolveRelayDialUrl,
} from './relay-dial';

const SELF: RelayDialContext = {
  roles: { relay: true },
  relayPublicUrl: 'https://relay.example',
  gatewayPort: 19993,
};

describe('resolveRelayDialUrl', () => {
  test('本机 relay 角色且 host 与公网地址相同则改写为回环', () => {
    expect(resolveRelayDialUrl('https://relay.example', SELF)).toBe('http://127.0.0.1:19993');
    expect(resolveRelayDialUrl('https://relay.example/path', SELF)).toBe('http://127.0.0.1:19993');
  });

  test('非本机中继或 host 不符则原样返回', () => {
    expect(
      resolveRelayDialUrl('https://relay.example', {
        roles: { relay: false },
        relayPublicUrl: 'https://relay.example',
        gatewayPort: 19993,
      })
    ).toBe('https://relay.example');
    expect(resolveRelayDialUrl('https://other.example', SELF)).toBe('https://other.example');
    expect(
      resolveRelayDialUrl('https://relay.example', {
        ...SELF,
        relayPublicUrl: null,
      })
    ).toBe('https://relay.example');
  });

  test('非法公网地址或端口越界不改写', () => {
    expect(resolveRelayDialUrl('https://relay.example', { ...SELF, gatewayPort: 0 })).toBe(
      'https://relay.example'
    );
    expect(
      resolveRelayDialUrl('https://relay.example', { ...SELF, relayPublicUrl: 'not a url' })
    ).toBe('https://relay.example');
  });
});

describe('isLoopbackRelayDial / CA pin', () => {
  test('回环 host 判定与 CA 跳过', () => {
    expect(isLoopbackRelayDial('http://127.0.0.1:19993')).toBe(true);
    expect(isLoopbackRelayDial('http://localhost:9')).toBe(true);
    expect(isLoopbackRelayDial('http://[::1]:9')).toBe(true);
    expect(isLoopbackRelayDial('https://relay.example')).toBe(false);
    expect(relayTlsCaForDial('http://127.0.0.1:19993', ['pem'])).toBeNull();
    expect(relayTlsCaForDial('https://relay.example', ['pem'])).toEqual(['pem']);
    expect(relayTlsCaForDial('https://relay.example', [])).toBeNull();
  });
});

describe('relayDialContextFromEnv', () => {
  test('从环境读取角色与端口', () => {
    const ctx = relayDialContextFromEnv({
      TMEX_ROLES: 'relay,node',
      TMEX_RELAY_PUBLIC_URL: 'https://relay.example',
      GATEWAY_PORT: '18883',
    });
    expect(ctx.roles.relay).toBe(true);
    expect(ctx.relayPublicUrl).toBe('https://relay.example');
    expect(ctx.gatewayPort).toBe(18883);
  });

  test('非法角色不当成中继', () => {
    expect(relayDialContextFromEnv({ TMEX_ROLES: 'nope' }).roles.relay).toBe(false);
  });

  test('runtime 快照与 env 同源时形状一致', () => {
    const fromEnv = relayDialContextFromEnv({
      TMEX_ROLES: 'relay,node',
      TMEX_RELAY_PUBLIC_URL: ' https://relay.example ',
      GATEWAY_PORT: '19993',
    });
    expect(
      relayDialContextFromRuntime({
        roles: { relay: true },
        relayPublicUrl: ' https://relay.example ',
        gatewayPort: 19993,
      })
    ).toEqual(fromEnv);
  });
});
