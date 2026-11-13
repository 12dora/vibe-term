import { describe, expect, test } from 'bun:test';
import type { NetworkInterfaceInfo } from 'node:os';
import { parseTurnDeniedPeers } from '../relay-turn-config';
import {
  DEFAULT_DENIED_PEER_CIDRS,
  PeerDenySet,
  createPeerPolicy,
  normalizePeerAddress,
  parseDeniedPeerList,
} from './denied-peers';

describe('denied peer policy', () => {
  test('defaults deny private and loopback, allow public', () => {
    const deny = createPeerPolicy(DEFAULT_DENIED_PEER_CIDRS);
    expect(deny('10.1.2.3')).toBe(true);
    expect(deny('192.168.2.1')).toBe(true);
    expect(deny('8.8.8.8')).toBe(false);
    expect(deny('::1')).toBe(true);
    expect(deny('fc00::1')).toBe(true);
    expect(deny('fe80::abcd')).toBe(true);
  });
  test('mapped IPv6 cannot bypass IPv4 rules', () => {
    const deny = createPeerPolicy(['10.0.0.0/8']);
    expect(deny('::ffff:10.2.3.4')).toBe(true);
    expect(normalizePeerAddress('::ffff:192.168.1.2')).toBe('192.168.1.2');
  });
  test('v6 boundaries and normalization', () => {
    const deny = createPeerPolicy(['2001:db8:1234::/48']);
    expect(deny('2001:db8:1234::1')).toBe(true);
    expect(deny('2001:db8:1235::1')).toBe(false);
    expect(normalizePeerAddress('2001:0db8:0:0:0:0:0:1')).toBe('2001:db8::1');
  });
  test('invalid CIDR and address throw', () => {
    expect(() => createPeerPolicy(['300.1.1.1/24'])).toThrow();
    expect(() => createPeerPolicy(['10.0.0.0/33'])).toThrow();
    expect(() => createPeerPolicy()('not-an-ip')).toThrow();
  });
});

describe('static deny ranges', () => {
  const deny = createPeerPolicy(DEFAULT_DENIED_PEER_CIDRS);
  test.each([
    ['100.64.0.1'],
    ['100.127.255.254'],
    ['192.0.0.8'],
    ['192.0.2.1'],
    ['198.51.100.7'],
    ['203.0.113.9'],
    ['::ffff:100.64.1.1'],
  ])('%s denied', (address) => {
    expect(deny(address)).toBe(true);
  });
  test('neighbours of the new ranges and public addresses stay allowed', () => {
    expect(deny('4.2.2.2')).toBe(false);
    expect(deny('100.128.0.1')).toBe(false);
    expect(deny('192.0.3.1')).toBe(false);
    expect(deny('198.51.101.1')).toBe(false);
    expect(deny('203.0.114.1')).toBe(false);
  });
});

describe('PeerDenySet self addresses', () => {
  const info = (address: string): NetworkInterfaceInfo => {
    const base = { address, mac: '00:00:00:00:00:00', internal: false, cidr: null };
    return address.includes(':')
      ? { ...base, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', scopeid: 0 }
      : { ...base, netmask: '255.255.255.0', family: 'IPv4' };
  };
  const ifaces = (addresses: string[]) => () => ({ eth0: addresses.map(info) });

  test('external IP and interface addresses are denied, public allowed', () => {
    const set = new PeerDenySet({ cidrs: [], listInterfaces: ifaces(['4.2.2.10', '2001:db8::5']) });
    set.refresh(['4.2.2.1']);
    expect(set.has('4.2.2.1')).toBe(true);
    expect(set.has('::ffff:4.2.2.1')).toBe(true);
    expect(set.has('4.2.2.10')).toBe(true);
    expect(set.has('2001:db8::5')).toBe(true);
    expect(set.has('4.2.2.2')).toBe(false);
  });

  test('refresh after external IP change replaces the old self address', () => {
    let current = ['4.2.2.10'];
    const set = new PeerDenySet({ cidrs: ['4.2.2.4/32'], listInterfaces: () => ifaces(current)() });
    set.refresh(['4.2.2.3']);
    expect(set.has('4.2.2.3')).toBe(true);
    set.refresh(['4.2.2.5']);
    expect(set.has('4.2.2.3')).toBe(false);
    expect(set.has('4.2.2.5')).toBe(true);
    set.refresh(['4.2.2.4']);
    set.refresh(['4.2.2.6']);
    expect(set.has('4.2.2.4')).toBe(true);
    current = ['4.2.2.11'];
    set.refresh(['4.2.2.6']);
    expect(set.has('4.2.2.10')).toBe(false);
    expect(set.has('4.2.2.11')).toBe(true);
  });

  test('unspecified and non-IP self entries are ignored; denySelf=false ignores refresh', () => {
    const set = new PeerDenySet({ cidrs: [], listInterfaces: ifaces([]) });
    set.refresh(['0.0.0.0', '::', 'auto', null, undefined]);
    expect(set.selfAddresses()).toEqual([]);
    const off = new PeerDenySet({
      cidrs: [],
      denySelf: false,
      listInterfaces: ifaces(['4.2.2.10']),
    });
    off.refresh(['4.2.2.1']);
    expect(off.has('4.2.2.1')).toBe(false);
    expect(off.has('4.2.2.10')).toBe(false);
  });

  test('interface listing failure falls back to explicit addresses', () => {
    const set = new PeerDenySet({
      cidrs: [],
      listInterfaces: () => {
        throw new Error('uv_interface_addresses');
      },
    });
    set.refresh(['4.2.2.1']);
    expect(set.selfAddresses()).toEqual(['4.2.2.1']);
  });
});

describe('VIBETERM_TURN_DENIED_PEERS parsing', () => {
  test('CIDRs and plain IPv4 (as /32), comma or whitespace separated', () => {
    expect(parseDeniedPeerList(' 4.2.2.0/24,4.2.2.9\n 8.8.4.4 ,, ')).toEqual({
      cidrs: ['4.2.2.0/24', '4.2.2.9/32', '8.8.4.4/32'],
      invalid: [],
    });
    expect(parseDeniedPeerList(undefined)).toEqual({ cidrs: [], invalid: [] });
  });

  test('invalid entries are skipped and warned once', () => {
    const warnings: string[] = [];
    const cidrs = parseTurnDeniedPeers(
      '4.2.2.0/24 300.1.1.1 4.2.2.2/33 2001:db8::/32 host.example 1.2.3.4/8/1 4.2.2.9',
      (line) => warnings.push(line)
    );
    expect(cidrs).toEqual([...DEFAULT_DENIED_PEER_CIDRS, '4.2.2.0/24', '4.2.2.9/32']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      '300.1.1.1, 4.2.2.2/33, 2001:db8::/32, host.example, 1.2.3.4/8/1'
    );
    const deny = createPeerPolicy(cidrs);
    expect(deny('4.2.2.77')).toBe(true);
    expect(deny('4.2.2.9')).toBe(true);
    expect(deny('8.8.8.8')).toBe(false);
  });

  test('valid input does not warn', () => {
    const warnings: string[] = [];
    parseTurnDeniedPeers('', (line) => warnings.push(line));
    parseTurnDeniedPeers('4.2.2.2', (line) => warnings.push(line));
    expect(warnings).toEqual([]);
  });
});
