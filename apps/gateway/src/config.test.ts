import { describe, expect, test } from 'bun:test';
import { BUILTIN_STUN_SERVERS } from '@vibeterm/shared/net';
import {
  LINK_STREAM_INFLIGHT_DEFAULT_BYTES,
  RELAY_AUTO_SELECT_INTERVAL_DEFAULT_MS,
  RELAY_AUTO_SELECT_INTERVAL_MAX_MS,
  RELAY_AUTO_SELECT_INTERVAL_MIN_MS,
  originUrlFromBindHost,
  parseLinkStreamInflightBytes,
  parsePeerBindHost,
  parsePeerPort,
  parsePeerPublicHost,
  parseRelayAutoSelect,
  parseRelayAutoSelectIntervalMs,
  parseRtcPortRange,
  parseTurnBindHost,
  parseTurnExternalIp,
  parseTurnHost,
  parseTurnPort,
  parseTurnRelayPortRange,
  parseVibeTermRoles,
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
  roles: { node: boolean; relay: boolean };
  peerPort: number;
  stunServers: string[];
  stunSource: 'builtin' | 'custom' | 'disabled';
  peerBindHost: string[];
  peerPublicHost: string | null;
  rtcPortRange: { begin: number; end: number } | null;
  turnUrl: string | null;
  turnUsername: string | null;
  turnCredential: string | null;
  turnPort: number;
  turnRelayPortRange: { begin: number; end: number };
  turnExternalIp: string | null;
  turnHost: string | null;
  turnBindHost: string;
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
        roles: { node: boolean; relay: boolean };
        peerPort: number;
        stunServers: string[];
        stunSource: 'builtin' | 'custom' | 'disabled';
        peerBindHost: string[];
        peerPublicHost: string | null;
        rtcPortRange: { begin: number; end: number } | null;
        turnUrl: string | null;
        turnUsername: string | null;
        turnCredential: string | null;
        turnPort: number;
        turnRelayPortRange: { begin: number; end: number };
        turnExternalIp: string | null;
        turnHost: string | null;
        turnBindHost: string;
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
      VIBETERM_MANAGEMENT_MODE: undefined,
      VIBETERM_UPDATE_OWNER: undefined,
    });
    expect(config.port).toBe(9663);
  });

  test('managed Gateway accepts an OS-assigned dynamic port', async () => {
    const config = await loadConfigWith({
      GATEWAY_PORT: '0',
      VIBETERM_MANAGEMENT_MODE: 'companion-cli',
      VIBETERM_UPDATE_OWNER: 'companion',
    });
    expect(config.port).toBe(0);
  });

  test('standalone Gateway rejects port zero', async () => {
    await expect(
      loadConfigWith({
        GATEWAY_PORT: '0',
        VIBETERM_MANAGEMENT_MODE: undefined,
        VIBETERM_UPDATE_OWNER: undefined,
      })
    ).rejects.toThrow('GATEWAY_PORT');
  });

  test('rejects malformed and out-of-range ports', async () => {
    for (const port of ['not-a-port', '9663suffix', '-1', '65536']) {
      await expect(
        loadConfigWith({
          GATEWAY_PORT: port,
          VIBETERM_MANAGEMENT_MODE: 'companion-cli',
          VIBETERM_UPDATE_OWNER: 'companion',
        })
      ).rejects.toThrow('GATEWAY_PORT');
    }
  });
});

describe('config.bindHost', () => {
  test('未设 VIBETERM_BIND_HOST 时默认 0.0.0.0', async () => {
    const config = await loadConfigWith({ VIBETERM_BIND_HOST: undefined });
    expect(config.bindHost).toBe('0.0.0.0');
  });

  test('VIBETERM_BIND_HOST 覆盖默认值（仅 localhost 绑定）', async () => {
    const config = await loadConfigWith({ VIBETERM_BIND_HOST: '127.0.0.1' });
    expect(config.bindHost).toBe('127.0.0.1');
  });

  test('支持任意主机地址值', async () => {
    const config = await loadConfigWith({ VIBETERM_BIND_HOST: '::1' });
    expect(config.bindHost).toBe('::1');
  });
});

describe('config.tmuxBin', () => {
  test('未设置时保持开源 Gateway 的 PATH 兼容默认值', async () => {
    const config = await loadConfigWith({ VIBETERM_TMUX_BIN: undefined });
    expect(config.tmuxBin).toBe('tmux');
  });

  test('接受 VIBETERM_TMUX_BIN 的绝对路径', async () => {
    const config = await loadConfigWith({ VIBETERM_TMUX_BIN: '/opt/vibex/bin/tmux' });
    expect(config.tmuxBin).toBe('/opt/vibex/bin/tmux');
  });

  test('拒绝相对 VIBETERM_TMUX_BIN', async () => {
    await expect(loadConfigWith({ VIBETERM_TMUX_BIN: './bundled/tmux' })).rejects.toThrow(
      'VIBETERM_TMUX_BIN must be an absolute path'
    );
  });

  test('Windows 使用 Windows 路径语义接受盘符与 UNC 绝对路径', () => {
    expect(
      resolveTmuxBin({ VIBETERM_TMUX_BIN: 'C:\\Program Files\\vibeterm\\psmux.exe' }, 'win32', true)
    ).toBe('C:\\Program Files\\vibeterm\\psmux.exe');
    expect(
      resolveTmuxBin({ VIBETERM_TMUX_BIN: '\\\\server\\share\\psmux.exe' }, 'win32', true)
    ).toBe('\\\\server\\share\\psmux.exe');
  });

  test('managed Windows 必须由调用方提供绝对 multiplexer 路径', () => {
    expect(() => resolveTmuxBin({}, 'win32', true)).toThrow(
      'VIBETERM_TMUX_BIN must be set to an absolute path on managed Windows'
    );
    expect(() =>
      resolveTmuxBin({ VIBETERM_TMUX_BIN: '.\\resources\\psmux.exe' }, 'win32', true)
    ).toThrow('VIBETERM_TMUX_BIN must be an absolute path');
    expect(resolveTmuxBin({}, 'win32', false)).toBe('tmux');
  });
});

describe('config.gatewayOwnerToken', () => {
  test('is optional for the open-source standalone Gateway', async () => {
    const config = await loadConfigWith({ VIBETERM_GATEWAY_OWNER_TOKEN: undefined });
    expect(config.gatewayOwnerToken).toBeNull();
  });

  test('accepts and normalizes a 32-byte managed owner token', async () => {
    const config = await loadConfigWith({ VIBETERM_GATEWAY_OWNER_TOKEN: 'AB'.repeat(32) });
    expect(config.gatewayOwnerToken).toBe('ab'.repeat(32));
  });

  test('rejects malformed owner tokens', async () => {
    await expect(loadConfigWith({ VIBETERM_GATEWAY_OWNER_TOKEN: 'not-a-token' })).rejects.toThrow(
      'exactly 32 bytes'
    );
  });
});

describe('parseVibeTermRoles', () => {
  test('defaults to standalone and accepts the legal values', () => {
    expect(parseVibeTermRoles(undefined)).toEqual({ node: false, relay: false });
    expect(parseVibeTermRoles('standalone')).toEqual({ node: false, relay: false });
    expect(parseVibeTermRoles('node')).toEqual({ node: true, relay: false });
  });

  test('accepts the relay roles', () => {
    expect(parseVibeTermRoles('relay')).toEqual({ node: false, relay: true });
    expect(parseVibeTermRoles('relay,node')).toEqual({ node: true, relay: true });
  });

  test('maps leftover hub,node to node and warns once', () => {
    const warn = console.warn;
    const messages: string[] = [];
    console.warn = (...args: unknown[]) => {
      messages.push(String(args[0]));
    };
    try {
      expect(parseVibeTermRoles('hub,node')).toEqual({ node: true, relay: false });
      expect(parseVibeTermRoles('hub,node')).toEqual({ node: true, relay: false });
    } finally {
      console.warn = warn;
    }
    expect(messages).toEqual([
      '[roles] VIBETERM_ROLES=hub,node is no longer supported; running as node',
    ]);
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
      expect(() => parseVibeTermRoles(raw)).toThrow('VIBETERM_ROLES');
    }
  });

  test('names the legal role set in the error message', () => {
    expect(() => parseVibeTermRoles('hub')).toThrow(
      'VIBETERM_ROLES must be one of standalone | node | relay | relay,node'
    );
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

describe('parsePeerPublicHost', () => {
  test('defaults to unset and accepts public IPv4 or FQDN', () => {
    expect(parsePeerPublicHost(undefined)).toBeNull();
    expect(parsePeerPublicHost('')).toBeNull();
    expect(parsePeerPublicHost('  ')).toBeNull();
    expect(parsePeerPublicHost(' 203.0.113.9 ')).toBe('203.0.113.9');
    expect(parsePeerPublicHost('tmexhub-sh.jiefakj.com')).toBe('tmexhub-sh.jiefakj.com');
    expect(parsePeerPublicHost('a.b')).toBe('a.b');
  });

  test('warns and ignores unadvertisable values', () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      expect(parsePeerPublicHost('10.0.0.3')).toBeNull();
      expect(parsePeerPublicHost('198.18.0.1')).toBeNull();
      expect(parsePeerPublicHost('100.64.1.1')).toBeNull();
      expect(parsePeerPublicHost('0.0.0.0')).toBeNull();
      expect(parsePeerPublicHost('240.0.0.1')).toBeNull();
      expect(parsePeerPublicHost('1.2.3.4.5')).toBeNull();
      expect(parsePeerPublicHost('1.2.3')).toBeNull();
      expect(parsePeerPublicHost('localhost')).toBeNull();
      expect(parsePeerPublicHost('not a host')).toBeNull();
      expect(parsePeerPublicHost('2001:db8::1')).toBeNull();
    } finally {
      console.warn = warn;
    }
    expect(warnings.length).toBe(10);
    expect(warnings.every((line) => line.includes('VIBETERM_PEER_PUBLIC_HOST'))).toBe(true);
  });
});

describe('parsePeerPort', () => {
  test('peer port defaults to 39001 and rejects out-of-range values', () => {
    expect(parsePeerPort(undefined)).toBe(39001);
    expect(parsePeerPort('')).toBe(39001);
    expect(parsePeerPort('443')).toBe(443);
    expect(() => parsePeerPort('0')).toThrow('VIBETERM_PEER_PORT');
    expect(() => parsePeerPort('65536')).toThrow('VIBETERM_PEER_PORT');
    expect(() => parsePeerPort('abc')).toThrow('VIBETERM_PEER_PORT');
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
      expect(() => parseRtcPortRange(value)).toThrow('VIBETERM_RTC_PORT_RANGE');
    }
  });
});

describe('parseTurnPort', () => {
  test('defaults to 40000 and treats 0/off as disabled', () => {
    expect(parseTurnPort(undefined)).toBe(40000);
    expect(parseTurnPort('')).toBe(40000);
    expect(parseTurnPort('0')).toBe(0);
    expect(parseTurnPort('off')).toBe(0);
    expect(parseTurnPort('OFF')).toBe(0);
    expect(parseTurnPort('3479')).toBe(3479);
  });

  test('rejects malformed values', () => {
    expect(() => parseTurnPort('abc')).toThrow('VIBETERM_TURN_PORT');
    expect(() => parseTurnPort('65536')).toThrow('VIBETERM_TURN_PORT');
  });
});

describe('parseTurnRelayPortRange', () => {
  test('defaults to 40001-40049', () => {
    expect(parseTurnRelayPortRange(undefined)).toEqual({ begin: 40001, end: 40049 });
    expect(parseTurnRelayPortRange('')).toEqual({ begin: 40001, end: 40049 });
    expect(parseTurnRelayPortRange(' 50000 - 50010 ')).toEqual({ begin: 50000, end: 50010 });
  });

  test('rejects malformed values', () => {
    expect(() => parseTurnRelayPortRange('50000')).toThrow('VIBETERM_TURN_RELAY_PORT_RANGE');
    expect(() => parseTurnRelayPortRange('2-1')).toThrow('VIBETERM_TURN_RELAY_PORT_RANGE');
  });
});

describe('parseTurnExternalIp / parseTurnHost', () => {
  test('accepts IPv4 and treats empty as unset', () => {
    expect(parseTurnExternalIp(undefined)).toBeNull();
    expect(parseTurnExternalIp(' 203.0.113.9 ')).toBe('203.0.113.9');
    expect(() => parseTurnExternalIp('relay.example')).toThrow('VIBETERM_TURN_EXTERNAL_IP');
    expect(parseTurnHost(undefined)).toBeNull();
    expect(parseTurnHost(' turn.example ')).toBe('turn.example');
  });
});

describe('parseTurnBindHost', () => {
  test('defaults to auto and accepts IPv4 / 0.0.0.0', () => {
    expect(parseTurnBindHost(undefined)).toBe('auto');
    expect(parseTurnBindHost('')).toBe('auto');
    expect(parseTurnBindHost('auto')).toBe('auto');
    expect(parseTurnBindHost('0.0.0.0')).toBe('0.0.0.0');
    expect(parseTurnBindHost('10.0.0.3')).toBe('10.0.0.3');
  });

  test('rejects invalid values', () => {
    expect(() => parseTurnBindHost('relay.example')).toThrow('VIBETERM_TURN_BIND_HOST');
    expect(() => parseTurnBindHost('::1')).toThrow('VIBETERM_TURN_BIND_HOST');
    expect(() => parseTurnBindHost('1.2.3.4.5')).toThrow('VIBETERM_TURN_BIND_HOST');
  });
});

describe('config node/relay env', () => {
  test('defaults roles to standalone and peerPort to 39001', async () => {
    const config = await loadConfigWith({
      VIBETERM_ROLES: undefined,
      VIBETERM_PEER_PORT: undefined,
      VIBETERM_STUN_SERVERS: undefined,
      VIBETERM_RTC_PORT_RANGE: undefined,
    });
    expect(config.roles).toEqual({ node: false, relay: false });
    expect(config.peerPort).toBe(39001);
    expect(config.stunServers).toEqual([...BUILTIN_STUN_SERVERS]);
    expect(config.stunSource).toBe('builtin');
    expect(config.peerBindHost).toEqual(['::', '0.0.0.0']);
    expect(config.peerPublicHost).toBeNull();
    expect(config.rtcPortRange).toBeNull();
  });

  test('parses VIBETERM_PEER_BIND_HOST comma-separated list', async () => {
    const config = await loadConfigWith({ VIBETERM_PEER_BIND_HOST: '127.0.0.1,::1' });
    expect(config.peerBindHost).toEqual(['127.0.0.1', '::1']);
  });

  test('parses VIBETERM_PEER_PUBLIC_HOST', async () => {
    const config = await loadConfigWith({ VIBETERM_PEER_PUBLIC_HOST: '203.0.113.9' });
    expect(config.peerPublicHost).toBe('203.0.113.9');
  });

  test('parses VIBETERM_RTC_PORT_RANGE', async () => {
    const config = await loadConfigWith({ VIBETERM_RTC_PORT_RANGE: '42000-42100' });
    expect(config.rtcPortRange).toEqual({ begin: 42000, end: 42100 });
  });

  test('parses node role and related TURN/STUN URLs', async () => {
    const config = await loadConfigWith({
      VIBETERM_ROLES: 'node',
      VIBETERM_PEER_PORT: '39001',
      VIBETERM_STUN_SERVERS: 'stun:stun.l.google.com:19302',
      VIBETERM_TURN_URL: 'turn:turn.example:3478',
      VIBETERM_TURN_USERNAME: 'u',
      VIBETERM_TURN_CREDENTIAL: 'p',
    });
    expect(config.roles).toEqual({ node: true, relay: false });
    expect(config.stunServers).toEqual(['stun:stun.l.google.com:19302']);
    expect(config.stunSource).toBe('custom');
    expect(config.turnUrl).toBe('turn:turn.example:3478');
    expect(config.turnUsername).toBe('u');
    expect(config.turnCredential).toBe('p');
  });

  test('parses builtin TURN env keys with defaults', async () => {
    const defaults = await loadConfigWith({
      VIBETERM_TURN_PORT: undefined,
      VIBETERM_TURN_RELAY_PORT_RANGE: undefined,
      VIBETERM_TURN_EXTERNAL_IP: undefined,
      VIBETERM_TURN_HOST: undefined,
      VIBETERM_TURN_BIND_HOST: undefined,
    });
    expect(defaults.turnPort).toBe(40000);
    expect(defaults.turnRelayPortRange).toEqual({ begin: 40001, end: 40049 });
    expect(defaults.turnExternalIp).toBeNull();
    expect(defaults.turnHost).toBeNull();
    expect(defaults.turnBindHost).toBe('auto');

    const custom = await loadConfigWith({
      VIBETERM_TURN_PORT: '0',
      VIBETERM_TURN_RELAY_PORT_RANGE: '50000-50010',
      VIBETERM_TURN_EXTERNAL_IP: '203.0.113.9',
      VIBETERM_TURN_HOST: 'turn.example',
      VIBETERM_TURN_BIND_HOST: '10.0.0.3',
    });
    expect(custom.turnPort).toBe(0);
    expect(custom.turnRelayPortRange).toEqual({ begin: 50000, end: 50010 });
    expect(custom.turnExternalIp).toBe('203.0.113.9');
    expect(custom.turnHost).toBe('turn.example');
    expect(custom.turnBindHost).toBe('10.0.0.3');
  });

  test('VIBETERM_STUN_SERVERS=none disables the local STUN list', async () => {
    const config = await loadConfigWith({ VIBETERM_STUN_SERVERS: 'none' });
    expect(config.stunServers).toEqual([]);
    expect(config.stunSource).toBe('disabled');
  });

  test('rejects invalid VIBETERM_ROLES at config load', async () => {
    await expect(loadConfigWith({ VIBETERM_ROLES: 'hub' })).rejects.toThrow('VIBETERM_ROLES');
  });
});

describe('config.trustProxy', () => {
  test('defaults to false and accepts 1/true/yes', async () => {
    const off = await loadConfigWith({ VIBETERM_TRUST_PROXY: undefined });
    expect(off.trustProxy).toBe(false);
    const on = await loadConfigWith({ VIBETERM_TRUST_PROXY: 'true' });
    expect(on.trustProxy).toBe(true);
    const one = await loadConfigWith({ VIBETERM_TRUST_PROXY: '1' });
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
    const v4 = await loadConfigWith({ VIBETERM_BIND_HOST: '0.0.0.0', GATEWAY_PORT: '19883' });
    expect(v4.originUrl).toBe('http://127.0.0.1:19883');
    const v6 = await loadConfigWith({ VIBETERM_BIND_HOST: '::', GATEWAY_PORT: '9443' });
    expect(v6.originUrl).toBe('http://[::1]:9443');
  });
});

describe('relay auto-select and stream inflight env', () => {
  test('转发会话在途上限缺省 256 KiB，只收整数且不低于 32 KiB', () => {
    expect(parseLinkStreamInflightBytes(undefined)).toBe(LINK_STREAM_INFLIGHT_DEFAULT_BYTES);
    expect(parseLinkStreamInflightBytes('')).toBe(LINK_STREAM_INFLIGHT_DEFAULT_BYTES);
    expect(parseLinkStreamInflightBytes(' 131072 ')).toBe(131072);
    expect(() => parseLinkStreamInflightBytes('1024')).toThrow(
      'VIBETERM_LINK_STREAM_INFLIGHT_BYTES'
    );
    expect(() => parseLinkStreamInflightBytes('-1')).toThrow('VIBETERM_LINK_STREAM_INFLIGHT_BYTES');
    expect(() => parseLinkStreamInflightBytes('1e6')).toThrow(
      'VIBETERM_LINK_STREAM_INFLIGHT_BYTES'
    );
  });

  test('relay auto-select is auto when unset and can be forced off or on', () => {
    expect(parseRelayAutoSelect(undefined)).toBeNull();
    expect(parseRelayAutoSelect('')).toBeNull();
    expect(parseRelayAutoSelect('0')).toBe(false);
    expect(parseRelayAutoSelect('off')).toBe(false);
    expect(parseRelayAutoSelect('false')).toBe(false);
    expect(parseRelayAutoSelect('1')).toBe(true);
    expect(parseRelayAutoSelect('on')).toBe(true);
    expect(() => parseRelayAutoSelect('maybe')).toThrow('VIBETERM_RELAY_AUTO_SELECT');
  });

  test('relay auto-select interval defaults to 60s', () => {
    expect(parseRelayAutoSelectIntervalMs(undefined)).toBe(RELAY_AUTO_SELECT_INTERVAL_DEFAULT_MS);
    expect(parseRelayAutoSelectIntervalMs('')).toBe(RELAY_AUTO_SELECT_INTERVAL_DEFAULT_MS);
    expect(parseRelayAutoSelectIntervalMs('15000')).toBe(15_000);
    expect(() => parseRelayAutoSelectIntervalMs('0')).toThrow(
      'VIBETERM_RELAY_AUTO_SELECT_INTERVAL_MS'
    );
    expect(() => parseRelayAutoSelectIntervalMs('nope')).toThrow(
      'VIBETERM_RELAY_AUTO_SELECT_INTERVAL_MS'
    );
    expect(parseRelayAutoSelectIntervalMs(String(RELAY_AUTO_SELECT_INTERVAL_MIN_MS))).toBe(
      RELAY_AUTO_SELECT_INTERVAL_MIN_MS
    );
    expect(parseRelayAutoSelectIntervalMs(String(RELAY_AUTO_SELECT_INTERVAL_MAX_MS))).toBe(
      RELAY_AUTO_SELECT_INTERVAL_MAX_MS
    );
    expect(() => parseRelayAutoSelectIntervalMs('999')).toThrow(
      'VIBETERM_RELAY_AUTO_SELECT_INTERVAL_MS'
    );
    expect(() =>
      parseRelayAutoSelectIntervalMs(String(RELAY_AUTO_SELECT_INTERVAL_MAX_MS + 1))
    ).toThrow('VIBETERM_RELAY_AUTO_SELECT_INTERVAL_MS');
  });
});

describe('config.memoryProfile', () => {
  test('import 时快照 VIBETERM_MEMORY_PROFILE', async () => {
    const saved = process.env.VIBETERM_MEMORY_PROFILE;
    process.env.VIBETERM_MEMORY_PROFILE = 'small';
    try {
      const mod = (await import(`./config.ts?memprofile=${Date.now()}`)) as {
        config: { memoryProfile: 'standard' | 'small' };
      };
      expect(mod.config.memoryProfile).toBe('small');
    } finally {
      if (saved === undefined) delete process.env.VIBETERM_MEMORY_PROFILE;
      else process.env.VIBETERM_MEMORY_PROFILE = saved;
    }
  });
});
