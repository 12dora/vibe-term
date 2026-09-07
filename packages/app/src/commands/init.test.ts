import { describe, expect, test } from 'bun:test';
import type { DirectEnableResult } from './direct';
import {
  applyPublicPort,
  enableDirectAfterInit,
  normalizeHubPublicUrl,
  normalizeRelayPublicUrl,
} from './init';

describe('normalizeRelayPublicUrl', () => {
  test('归一化 https 地址', () => {
    expect(normalizeRelayPublicUrl(' https://Relay.Example.com:443/ ')).toBe(
      'https://relay.example.com'
    );
    expect(normalizeRelayPublicUrl('http://127.0.0.1:19883')).toBe('http://127.0.0.1:19883');
  });

  test('拒绝空值与非 https 的公网地址', () => {
    expect(() => normalizeRelayPublicUrl('')).toThrow('cannot be empty');
    expect(() => normalizeRelayPublicUrl('   ')).toThrow('cannot be empty');
    expect(() => normalizeRelayPublicUrl('http://relay.example.com')).toThrow(
      'invalid relay public URL'
    );
    expect(() => normalizeRelayPublicUrl('relay.example.com')).toThrow('invalid relay public URL');
  });
});

describe('normalizeHubPublicUrl', () => {
  test('归一化 https 地址并保留非标端口', () => {
    expect(normalizeHubPublicUrl(' https://Hub.Example.com:443/ ')).toBe('https://hub.example.com');
    expect(normalizeHubPublicUrl('https://hub.example.com:13443')).toBe(
      'https://hub.example.com:13443'
    );
    expect(normalizeHubPublicUrl('http://127.0.0.1:19883')).toBe('http://127.0.0.1:19883');
  });

  test('拒绝空值与非 https 的公网地址', () => {
    expect(() => normalizeHubPublicUrl('   ')).toThrow('cannot be empty');
    expect(() => normalizeHubPublicUrl('http://hub.example.com')).toThrow('invalid hub public URL');
    expect(() => normalizeHubPublicUrl('hub.example.com')).toThrow('invalid hub public URL');
  });
});

describe('applyPublicPort', () => {
  test('地址没写端口时补上选定的公网端口', () => {
    expect(applyPublicPort('https://hub.example.com', 13443)).toBe('https://hub.example.com:13443');
    expect(applyPublicPort(' hub.example.com ', 13443)).toBe('https://hub.example.com:13443');
  });

  test('显式端口与 443 都原样返回', () => {
    expect(applyPublicPort('https://hub.example.com:8443', 13443)).toBe(
      'https://hub.example.com:8443'
    );
    expect(applyPublicPort('https://hub.example.com', 443)).toBe('https://hub.example.com');
    expect(applyPublicPort('', 13443)).toBe('');
  });

  test('无法解析的地址原样交给后面的校验', () => {
    expect(applyPublicPort('ftp://hub.example.com', 13443)).toBe('ftp://hub.example.com');
  });
});

describe('enableDirectAfterInit', () => {
  test('calls enableDirect for node role and does not throw on failure', async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    await enableDirectAfterInit(
      { role: 'node', installDir: '/tmp/vibeterm-init-node' },
      {
        enableDirect: async ({ installDir }) => {
          calls.push(installDir);
          return { ok: false, reason: 'fake registry down' };
        },
        log: (message) => logs.push(message),
      }
    );
    expect(calls).toEqual(['/tmp/vibeterm-init-node']);
    expect(logs.join('\n')).toContain('fake registry down');
  });

  test('calls enableDirect for hub,node and logs success', async () => {
    const logs: string[] = [];
    const ok: DirectEnableResult = {
      ok: true,
      platformId: 'darwin-arm64',
      version: '0.33.1',
      addonPath: '/tmp/native/node_datachannel.node',
    };
    await enableDirectAfterInit(
      { role: 'hub,node', installDir: '/tmp/vibeterm-init-hub' },
      {
        enableDirect: async () => ok,
        log: (message) => logs.push(message),
      }
    );
    expect(logs.join('\n')).toContain('darwin-arm64');
  });

  test.each(['standalone', 'node', 'hub,node', 'relay', 'relay,node'])(
    '角色 %s 默认安装并传入超时信号',
    async (role) => {
      let called = false;
      await enableDirectAfterInit(
        { role, installDir: '/tmp/vibeterm-init-standalone' },
        {
          enableDirect: async ({ signal, skipExisting }) => {
            expect(signal).toBeInstanceOf(AbortSignal);
            expect(signal?.aborted).toBe(false);
            expect(skipExisting).toBe(true);
            called = true;
            return { ok: true, platformId: 'x', version: '1', addonPath: 'y' };
          },
        }
      );
      expect(called).toBe(true);
    }
  );

  test('swallows thrown errors from enableDirect and logs the real message', async () => {
    const logs: string[] = [];
    await enableDirectAfterInit(
      { role: 'node', installDir: '/tmp/vibeterm-init-throw' },
      {
        enableDirect: async () => {
          throw new Error('network exploded');
        },
        log: (message) => logs.push(message),
      }
    );
    expect(logs.join('\n')).toContain('network exploded');
  });
});
