import { describe, expect, test } from 'bun:test';
import { validateRoles } from '@tmex/shared';
import {
  HUB_AUTO_PROMOTE_TIMEOUT_DEFAULT_MS,
  originUrlFromBindHost,
  parseHubAutoPromote,
  parseHubAutoPromoteTimeoutMs,
  parsePeerBindHost,
  parsePeerPort,
  parseRtcPortRange,
  parseStunServers,
  parseTmexRoles,
  parseUplinkPreferNearest,
  resolveTmuxBin,
} from './config';

// config 是模块级常量（import 时快照 process.env），
// 用 query-busting 动态 import 在不同 env 下重新求值。
let bustCounter = 0;

async function loadConfigWith(env: Record<string, string | undefined>): Promise<{
  port: number;
  bindHost: string;
  tmuxBin: string;
  gatewayOwnerToken: string | null;
  roles: { hub: boolean; node: boolean; relay: boolean };
  hubUrl: string | null;
  hubPublicUrl: string | null;
  hubMode: 'active' | 'standby';
  hubPriority: number;
  hubWriterEpoch: number;
  hubUrls: string[];
  hubPeers: string[];
  peerPort: number;
  stunServers: string[];
  peerBindHost: string[];
  rtcPortRange: { begin: number; end: number } | null;
  turnUrl: string | null;
  turnUsername: string | null;
  turnCredential: string | null;
  originUrl: string;
  trustProxy: boolean;
}> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    bustCounter += 1;
    const mod = (await import(`./config.ts?bust=${bustCounter}`)) as {
      config: {
        port: number;
        bindHost: string;
        tmuxBin: string;
        gatewayOwnerToken: string | null;
        roles: { hub: boolean; node: boolean; relay: boolean };
        hubUrl: string | null;
        hubPublicUrl: string | null;
        hubMode: 'active' | 'standby';
        hubPriority: number;
        hubWriterEpoch: number;
        hubUrls: string[];
        hubPeers: string[];
        peerPort: number;
        stunServers: string[];
        peerBindHost: string[];
        rtcPortRange: { begin: number; end: number } | null;
        turnUrl: string | null;
        turnUsername: string | null;
        turnCredential: string | null;
        trustProxy: boolean;
        originUrl: string;
      };
    };
    return mod.config;
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('config.port', () => {
  test('standalone Gateway keeps port 9663 as its default', async () => {
    const config = await loadConfigWith({
      GATEWAY_PORT: undefined,
      TMEX_MANAGEMENT_MODE: undefined,
      TMEX_UPDATE_OWNER: undefined,
    });
    expect(config.port).toBe(9663);
  });

  test('managed Gateway accepts an OS-assigned dynamic port', async () => {
    const config = await loadConfigWith({
      GATEWAY_PORT: '0',
      TMEX_MANAGEMENT_MODE: 'companion-cli',
      TMEX_UPDATE_OWNER: 'companion',
    });
    expect(config.port).toBe(0);
  });

  test('standalone Gateway rejects port zero', async () => {
    await expect(
      loadConfigWith({
        GATEWAY_PORT: '0',
        TMEX_MANAGEMENT_MODE: undefined,
        TMEX_UPDATE_OWNER: undefined,
      })
    ).rejects.toThrow('GATEWAY_PORT');
  });

  test('rejects malformed and out-of-range ports', async () => {
    for (const port of ['not-a-port', '9663suffix', '-1', '65536']) {
      await expect(
        loadConfigWith({
          GATEWAY_PORT: port,
          TMEX_MANAGEMENT_MODE: 'companion-cli',
          TMEX_UPDATE_OWNER: 'companion',
        })
      ).rejects.toThrow('GATEWAY_PORT');
    }
  });
});

describe('config.bindHost', () => {
  test('未设 TMEX_BIND_HOST 时默认 0.0.0.0', async () => {
    const config = await loadConfigWith({ TMEX_BIND_HOST: undefined });
    expect(config.bindHost).toBe('0.0.0.0');
  });

  test('TMEX_BIND_HOST 覆盖默认值（仅 localhost 绑定）', async () => {
    const config = await loadConfigWith({ TMEX_BIND_HOST: '127.0.0.1' });
    expect(config.bindHost).toBe('127.0.0.1');
  });

  test('支持任意主机地址值', async () => {
    const config = await loadConfigWith({ TMEX_BIND_HOST: '::1' });
    expect(config.bindHost).toBe('::1');
  });
});

describe('config.tmuxBin', () => {
  test('未设置时保持开源 Gateway 的 PATH 兼容默认值', async () => {
    const config = await loadConfigWith({ TMEX_TMUX_BIN: undefined });
    expect(config.tmuxBin).toBe('tmux');
  });

  test('接受 TMEX_TMUX_BIN 的绝对路径', async () => {
    const config = await loadConfigWith({ TMEX_TMUX_BIN: '/opt/vibex/bin/tmux' });
    expect(config.tmuxBin).toBe('/opt/vibex/bin/tmux');
  });

  test('拒绝相对 TMEX_TMUX_BIN', async () => {
    await expect(loadConfigWith({ TMEX_TMUX_BIN: './bundled/tmux' })).rejects.toThrow(
      'TMEX_TMUX_BIN must be an absolute path'
    );
  });

  test('Windows 使用 Windows 路径语义接受盘符与 UNC 绝对路径', () => {
    expect(
      resolveTmuxBin({ TMEX_TMUX_BIN: 'C:\\Program Files\\tmex\\psmux.exe' }, 'win32', true)
    ).toBe('C:\\Program Files\\tmex\\psmux.exe');
    expect(resolveTmuxBin({ TMEX_TMUX_BIN: '\\\\server\\share\\psmux.exe' }, 'win32', true)).toBe(
      '\\\\server\\share\\psmux.exe'
    );
  });

  test('managed Windows 必须由调用方提供绝对 multiplexer 路径', () => {
    expect(() => resolveTmuxBin({}, 'win32', true)).toThrow(
      'TMEX_TMUX_BIN must be set to an absolute path on managed Windows'
    );
    expect(() =>
      resolveTmuxBin({ TMEX_TMUX_BIN: '.\\resources\\psmux.exe' }, 'win32', true)
    ).toThrow('TMEX_TMUX_BIN must be an absolute path');
    expect(resolveTmuxBin({}, 'win32', false)).toBe('tmux');
  });
});

describe('config.gatewayOwnerToken', () => {
  test('is optional for the open-source standalone Gateway', async () => {
    const config = await loadConfigWith({ TMEX_GATEWAY_OWNER_TOKEN: undefined });
    expect(config.gatewayOwnerToken).toBeNull();
  });

  test('accepts and normalizes a 32-byte managed owner token', async () => {
    const config = await loadConfigWith({ TMEX_GATEWAY_OWNER_TOKEN: 'AB'.repeat(32) });
    expect(config.gatewayOwnerToken).toBe('ab'.repeat(32));
  });

  test('rejects malformed owner tokens', async () => {
    await expect(loadConfigWith({ TMEX_GATEWAY_OWNER_TOKEN: 'not-a-token' })).rejects.toThrow(
      'exactly 32 bytes'
    );
  });
});

describe('parseTmexRoles', () => {
  test('defaults to standalone and accepts the legal values', () => {
    expect(parseTmexRoles(undefined)).toEqual({ hub: false, node: false, relay: false });
    expect(parseTmexRoles('standalone')).toEqual({ hub: false, node: false, relay: false });
    expect(parseTmexRoles('node')).toEqual({ hub: false, node: true, relay: false });
    expect(parseTmexRoles('hub,node')).toEqual({ hub: true, node: true, relay: false });
  });

  test('accepts the relay roles', () => {
    expect(parseTmexRoles('relay')).toEqual({ hub: false, node: false, relay: true });
    expect(parseTmexRoles('relay,node')).toEqual({ hub: false, node: true, relay: true });
  });

  test('rejects hub combined with relay', () => {
    expect(validateRoles({ hub: true, node: true, relay: true })).toBe(
      'relay cannot be combined with hub'
    );
    expect(validateRoles({ hub: false, node: true, relay: true })).toBeNull();
  });

  test('rejects anything else including pure hub and reordered roles', () => {
    for (const raw of [
      '',
      '   ',
      'hub',
      'node,hub',
      'standalone,node',
      'hub,node,node',
      'HUB,NODE',
      'hub,relay',
      'node,relay',
      'relay,hub,node',
    ]) {
      expect(() => parseTmexRoles(raw)).toThrow('TMEX_ROLES');
    }
  });

  test('names relay in the error message', () => {
    expect(() => parseTmexRoles('hub')).toThrow('relay | relay,node');
  });
});

describe('parsePeerBindHost', () => {
  test('defaults to dual-stack :: and 0.0.0.0', () => {
    expect(parsePeerBindHost(undefined)).toEqual(['::', '0.0.0.0']);
    expect(parsePeerBindHost('')).toEqual(['::', '0.0.0.0']);
    expect(parsePeerBindHost('  ,  , ')).toEqual(['::', '0.0.0.0']);
  });

  test('splits comma-separated hosts and drops empty items', () => {
    expect(parsePeerBindHost('127.0.0.1')).toEqual(['127.0.0.1']);
    expect(parsePeerBindHost('127.0.0.1, ::, 0.0.0.0')).toEqual(['127.0.0.1', '::', '0.0.0.0']);
    expect(parsePeerBindHost('::1,,0.0.0.0')).toEqual(['::1', '0.0.0.0']);
  });
});

describe('parsePeerPort / parseStunServers', () => {
  test('peer port defaults to 39001 and rejects out-of-range values', () => {
    expect(parsePeerPort(undefined)).toBe(39001);
    expect(parsePeerPort('')).toBe(39001);
    expect(parsePeerPort('443')).toBe(443);
    expect(() => parsePeerPort('0')).toThrow('TMEX_PEER_PORT');
    expect(() => parsePeerPort('65536')).toThrow('TMEX_PEER_PORT');
    expect(() => parsePeerPort('abc')).toThrow('TMEX_PEER_PORT');
  });

  test('stun servers split on commas and drop empty items', () => {
    expect(parseStunServers(undefined)).toEqual([]);
    expect(parseStunServers('stun:a, stun:b,,stun:c')).toEqual(['stun:a', 'stun:b', 'stun:c']);
  });
});

describe('parseRtcPortRange', () => {
  test('accepts an ordered UDP port range and treats empty input as disabled', () => {
    expect(parseRtcPortRange(undefined)).toBeNull();
    expect(parseRtcPortRange('')).toBeNull();
    expect(parseRtcPortRange(' 40000 - 40100 ')).toEqual({ begin: 40000, end: 40100 });
    expect(parseRtcPortRange('443-443')).toEqual({ begin: 443, end: 443 });
  });

  test('rejects malformed, reversed, and out-of-range values', () => {
    for (const value of ['40000', '1.5-2', '200-100', '0-100', '1-65536']) {
      expect(() => parseRtcPortRange(value)).toThrow('TMEX_RTC_PORT_RANGE');
    }
  });
});

describe('config hub/node env', () => {
  test('defaults roles to standalone and peerPort to 39001', async () => {
    const config = await loadConfigWith({
      TMEX_ROLES: undefined,
      TMEX_PEER_PORT: undefined,
      TMEX_HUB_URL: undefined,
      TMEX_STUN_SERVERS: undefined,
      TMEX_RTC_PORT_RANGE: undefined,
    });
    expect(config.roles).toEqual({ hub: false, node: false, relay: false });
    expect(config.peerPort).toBe(39001);
    expect(config.hubUrl).toBeNull();
    expect(config.stunServers).toEqual([]);
    expect(config.peerBindHost).toEqual(['::', '0.0.0.0']);
    expect(config.rtcPortRange).toBeNull();
  });

  test('parses TMEX_PEER_BIND_HOST comma-separated list', async () => {
    const config = await loadConfigWith({ TMEX_PEER_BIND_HOST: '127.0.0.1,::1' });
    expect(config.peerBindHost).toEqual(['127.0.0.1', '::1']);
  });

  test('parses TMEX_RTC_PORT_RANGE', async () => {
    const config = await loadConfigWith({ TMEX_RTC_PORT_RANGE: '42000-42100' });
    expect(config.rtcPortRange).toEqual({ begin: 42000, end: 42100 });
  });

  test('parses hub,node role and related URLs', async () => {
    const config = await loadConfigWith({
      TMEX_ROLES: 'hub,node',
      TMEX_HUB_URL: 'https://hub.example',
      TMEX_HUB_PUBLIC_URL: 'https://hub.example',
      TMEX_PEER_PORT: '39001',
      TMEX_STUN_SERVERS: 'stun:stun.l.google.com:19302',
      TMEX_TURN_URL: 'turn:turn.example:3478',
      TMEX_TURN_USERNAME: 'u',
      TMEX_TURN_CREDENTIAL: 'p',
    });
    expect(config.roles).toEqual({ hub: true, node: true, relay: false });
    expect(config.hubUrl).toBe('https://hub.example');
    expect(config.hubPublicUrl).toBe('https://hub.example');
    expect(config.stunServers).toEqual(['stun:stun.l.google.com:19302']);
    expect(config.turnUrl).toBe('turn:turn.example:3478');
    expect(config.turnUsername).toBe('u');
    expect(config.turnCredential).toBe('p');
  });

  test('rejects invalid TMEX_ROLES at config load', async () => {
    await expect(loadConfigWith({ TMEX_ROLES: 'hub' })).rejects.toThrow('TMEX_ROLES');
  });

  test('hubMode/priority/epoch 默认值：active=100/1，standby 默认 priority 200', async () => {
    const unset = await loadConfigWith({
      TMEX_ROLES: 'hub,node',
      TMEX_HUB_MODE: undefined,
      TMEX_HUB_PRIORITY: undefined,
      TMEX_HUB_WRITER_EPOCH: undefined,
      TMEX_HUB_URLS: undefined,
    });
    expect(unset.hubMode).toBe('active');
    expect(unset.hubPriority).toBe(100);
    expect(unset.hubWriterEpoch).toBe(1);
    expect(unset.hubUrls).toEqual([]);

    const standby = await loadConfigWith({
      TMEX_ROLES: 'hub,node',
      TMEX_HUB_MODE: 'standby',
      TMEX_HUB_PRIORITY: undefined,
    });
    expect(standby.hubMode).toBe('standby');
    expect(standby.hubPriority).toBe(200);

    const custom = await loadConfigWith({
      TMEX_HUB_MODE: 'standby',
      TMEX_HUB_PRIORITY: '5',
      TMEX_HUB_WRITER_EPOCH: '9',
    });
    expect(custom.hubMode).toBe('standby');
    expect(custom.hubPriority).toBe(5);
    expect(custom.hubWriterEpoch).toBe(9);
  });

  test('拒绝非法 TMEX_HUB_MODE / PRIORITY / WRITER_EPOCH', async () => {
    await expect(loadConfigWith({ TMEX_HUB_MODE: 'primary' })).rejects.toThrow('TMEX_HUB_MODE');
    await expect(loadConfigWith({ TMEX_HUB_PRIORITY: '-1' })).rejects.toThrow('TMEX_HUB_PRIORITY');
    await expect(loadConfigWith({ TMEX_HUB_PRIORITY: '1.5' })).rejects.toThrow('TMEX_HUB_PRIORITY');
    await expect(loadConfigWith({ TMEX_HUB_WRITER_EPOCH: '0' })).rejects.toThrow(
      'TMEX_HUB_WRITER_EPOCH'
    );
    await expect(loadConfigWith({ TMEX_HUB_WRITER_EPOCH: 'abc' })).rejects.toThrow(
      'TMEX_HUB_WRITER_EPOCH'
    );
  });

  test('TMEX_HUB_URLS 接在 TMEX_HUB_URL 之后去重', async () => {
    const onlySeed = await loadConfigWith({
      TMEX_HUB_URL: 'https://hub.example',
      TMEX_HUB_URLS: undefined,
    });
    expect(onlySeed.hubUrl).toBe('https://hub.example');
    expect(onlySeed.hubUrls).toEqual(['https://hub.example']);

    const merged = await loadConfigWith({
      TMEX_HUB_URL: 'https://hub.example',
      TMEX_HUB_URLS: 'https://standby.example, https://hub.example, https://other.example',
    });
    expect(merged.hubUrls).toEqual([
      'https://hub.example',
      'https://standby.example',
      'https://other.example',
    ]);

    const urlsOnly = await loadConfigWith({
      TMEX_HUB_URL: undefined,
      TMEX_HUB_URLS: 'https://a.example,, https://b.example',
    });
    expect(urlsOnly.hubUrls).toEqual(['https://a.example', 'https://b.example']);
  });

  test('TMEX_HUB_PEERS 默认空，校验 32-hex、去重、小写', async () => {
    const unset = await loadConfigWith({ TMEX_HUB_PEERS: undefined });
    expect(unset.hubPeers).toEqual([]);

    const empty = await loadConfigWith({ TMEX_HUB_PEERS: '' });
    expect(empty.hubPeers).toEqual([]);

    const a = 'aa'.repeat(16);
    const b = 'bb'.repeat(16);
    const parsed = await loadConfigWith({
      TMEX_HUB_PEERS: ` ${a.toUpperCase()},, ${b}, ${a} `,
    });
    expect(parsed.hubPeers).toEqual([a, b]);
  });

  test('拒绝非法 TMEX_HUB_PEERS', async () => {
    await expect(loadConfigWith({ TMEX_HUB_PEERS: 'not-hex' })).rejects.toThrow('TMEX_HUB_PEERS');
    await expect(loadConfigWith({ TMEX_HUB_PEERS: 'aa'.repeat(15) })).rejects.toThrow(
      'TMEX_HUB_PEERS'
    );
    await expect(loadConfigWith({ TMEX_HUB_PEERS: `${'aa'.repeat(16)},zz` })).rejects.toThrow(
      'TMEX_HUB_PEERS'
    );
  });
});

describe('config.trustProxy', () => {
  test('defaults to false and accepts 1/true/yes', async () => {
    const off = await loadConfigWith({ TMEX_TRUST_PROXY: undefined });
    expect(off.trustProxy).toBe(false);
    const on = await loadConfigWith({ TMEX_TRUST_PROXY: 'true' });
    expect(on.trustProxy).toBe(true);
    const one = await loadConfigWith({ TMEX_TRUST_PROXY: '1' });
    expect(one.trustProxy).toBe(true);
  });
});

describe('config.originUrl', () => {
  test('maps bind host wildcards to a connectable origin', async () => {
    expect(originUrlFromBindHost('0.0.0.0', 19883)).toBe('http://127.0.0.1:19883');
    expect(originUrlFromBindHost('::', 19883)).toBe('http://[::1]:19883');
    expect(originUrlFromBindHost('[::]', 80)).toBe('http://[::1]:80');
    expect(originUrlFromBindHost('10.0.0.2', 9663)).toBe('http://10.0.0.2:9663');
    expect(originUrlFromBindHost('2001:db8::1', 9663)).toBe('http://[2001:db8::1]:9663');
    const v4 = await loadConfigWith({ TMEX_BIND_HOST: '0.0.0.0', GATEWAY_PORT: '19883' });
    expect(v4.originUrl).toBe('http://127.0.0.1:19883');
    const v6 = await loadConfigWith({ TMEX_BIND_HOST: '::', GATEWAY_PORT: '9443' });
    expect(v6.originUrl).toBe('http://[::1]:9443');
  });
});

describe('hub auto-promote and nearest-uplink env', () => {
  test('auto-promote defaults off and accepts 1/true/yes/on', () => {
    expect(parseHubAutoPromote(undefined)).toBe(false);
    expect(parseHubAutoPromote('')).toBe(false);
    expect(parseHubAutoPromote('0')).toBe(false);
    expect(parseHubAutoPromote('1')).toBe(true);
    expect(parseHubAutoPromote('true')).toBe(true);
    expect(parseHubAutoPromote('YES')).toBe(true);
    expect(parseHubAutoPromote('on')).toBe(true);
  });

  test('auto-promote timeout defaults to 10 minutes', () => {
    expect(parseHubAutoPromoteTimeoutMs(undefined)).toBe(HUB_AUTO_PROMOTE_TIMEOUT_DEFAULT_MS);
    expect(parseHubAutoPromoteTimeoutMs('')).toBe(600_000);
    expect(parseHubAutoPromoteTimeoutMs('1000')).toBe(1_000);
    expect(() => parseHubAutoPromoteTimeoutMs('0')).toThrow('TMEX_HUB_AUTO_PROMOTE_TIMEOUT_MS');
    expect(() => parseHubAutoPromoteTimeoutMs('-1')).toThrow('TMEX_HUB_AUTO_PROMOTE_TIMEOUT_MS');
    expect(() => parseHubAutoPromoteTimeoutMs('1.5')).toThrow('TMEX_HUB_AUTO_PROMOTE_TIMEOUT_MS');
  });

  test('prefer-nearest is auto when unset and can be forced off or on', () => {
    expect(parseUplinkPreferNearest(undefined)).toBeNull();
    expect(parseUplinkPreferNearest('')).toBeNull();
    expect(parseUplinkPreferNearest('0')).toBe(false);
    expect(parseUplinkPreferNearest('off')).toBe(false);
    expect(parseUplinkPreferNearest('false')).toBe(false);
    expect(parseUplinkPreferNearest('1')).toBe(true);
    expect(parseUplinkPreferNearest('on')).toBe(true);
    expect(() => parseUplinkPreferNearest('maybe')).toThrow('TMEX_UPLINK_PREFER_NEAREST');
  });
});
