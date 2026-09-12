import { describe, expect, test } from 'bun:test';
import type os from 'node:os';
import {
  discoverPrimaryOutboundIPv4,
  parseTurnBindHost,
  resolveTurnListenHost,
} from './local-address';

function ipv4(address: string, internal = false): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  };
}

describe('parseTurnBindHost', () => {
  test('unset / empty / auto → auto', () => {
    expect(parseTurnBindHost(undefined)).toBe('auto');
    expect(parseTurnBindHost('')).toBe('auto');
    expect(parseTurnBindHost('  ')).toBe('auto');
    expect(parseTurnBindHost('auto')).toBe('auto');
    expect(parseTurnBindHost(' AUTO ')).toBe('auto');
  });

  test('accepts 0.0.0.0 and IPv4 literals', () => {
    expect(parseTurnBindHost('0.0.0.0')).toBe('0.0.0.0');
    expect(parseTurnBindHost(' 10.0.0.3 ')).toBe('10.0.0.3');
    expect(parseTurnBindHost('127.0.0.1')).toBe('127.0.0.1');
  });

  test('rejects hostnames, IPv6, and malformed values', () => {
    expect(() => parseTurnBindHost('relay.example')).toThrow('VIBETERM_TURN_BIND_HOST');
    expect(() => parseTurnBindHost('::')).toThrow('VIBETERM_TURN_BIND_HOST');
    expect(() => parseTurnBindHost('::1')).toThrow('VIBETERM_TURN_BIND_HOST');
    expect(() => parseTurnBindHost('999.1.1.1')).toThrow('VIBETERM_TURN_BIND_HOST');
    expect(() => parseTurnBindHost('1.2.3')).toThrow('VIBETERM_TURN_BIND_HOST');
  });
});

describe('discoverPrimaryOutboundIPv4', () => {
  test('UDP connect wins over interface enumeration', async () => {
    const ip = await discoverPrimaryOutboundIPv4({
      connectUdp: async () => '10.0.0.3',
      listInterfaces: () => ({ eth0: [ipv4('192.0.2.1')] }),
    });
    expect(ip).toBe('10.0.0.3');
  });

  test('unusable UDP result falls through to the first non-internal IPv4', async () => {
    const ip = await discoverPrimaryOutboundIPv4({
      connectUdp: async () => '198.18.0.1',
      listInterfaces: () => ({
        lo: [ipv4('127.0.0.1', true)],
        mihomo: [ipv4('198.18.0.1')],
        eth0: [ipv4('10.0.0.3')],
      }),
    });
    expect(ip).toBe('10.0.0.3');
  });

  test('loopback UDP result is ignored', async () => {
    const ip = await discoverPrimaryOutboundIPv4({
      connectUdp: async () => '127.0.0.1',
      listInterfaces: () => ({ en0: [ipv4('192.168.1.8')] }),
    });
    expect(ip).toBe('192.168.1.8');
  });

  test('skips internal and IPv6 interface addresses', async () => {
    const ip = await discoverPrimaryOutboundIPv4({
      connectUdp: async () => null,
      listInterfaces: () => ({
        lo: [ipv4('127.0.0.1', true)],
        eth0: [
          {
            address: '2001:db8::1',
            netmask: 'ffff:ffff:ffff:ffff::',
            family: 'IPv6',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: '2001:db8::1/64',
            scopeid: 0,
          },
          ipv4('203.0.113.8'),
        ],
      }),
    });
    expect(ip).toBe('203.0.113.8');
  });

  test('bridge / TUN / overlay interfaces rank after physical ones and CGNAT is skipped', async () => {
    const ip = await discoverPrimaryOutboundIPv4({
      connectUdp: async () => '198.18.0.1',
      listInterfaces: () => ({
        lxdbr0: [
          { address: '10.108.57.1', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo,
        ],
        wt0: [
          { address: '100.75.213.124', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo,
        ],
        mihomo: [
          { address: '198.18.0.1', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo,
        ],
        eth0: [{ address: '10.0.0.3', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo],
      }),
    });
    expect(ip).toBe('10.0.0.3');
    const onlyBridge = await discoverPrimaryOutboundIPv4({
      connectUdp: async () => null,
      listInterfaces: () => ({
        docker0: [
          { address: '172.17.0.1', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo,
        ],
      }),
    });
    expect(onlyBridge).toBe('172.17.0.1');
  });

  test('no usable address returns 0.0.0.0 and warns', async () => {
    const warns: string[] = [];
    const ip = await discoverPrimaryOutboundIPv4({
      connectUdp: async () => null,
      listInterfaces: () => ({
        lo: [ipv4('127.0.0.1', true)],
        utun: [ipv4('198.18.0.1')],
      }),
      warn: (line) => warns.push(line),
    });
    expect(ip).toBe('0.0.0.0');
    expect(warns.some((line) => line.includes('0.0.0.0'))).toBe(true);
  });
});

describe('resolveTurnListenHost', () => {
  test('auto discovers; literals pass through', async () => {
    expect(
      await resolveTurnListenHost('auto', {
        connectUdp: async () => '10.0.0.3',
        listInterfaces: () => ({}),
      })
    ).toBe('10.0.0.3');
    expect(await resolveTurnListenHost('0.0.0.0')).toBe('0.0.0.0');
    expect(await resolveTurnListenHost('192.0.2.9')).toBe('192.0.2.9');
  });
});
