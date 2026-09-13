import { describe, expect, test } from 'bun:test';
import type os from 'node:os';
import {
  enumeratePeerEndpoints,
  stunMappedAddressesForAdvertise,
  usablePublicIpv4,
} from './peer-endpoints';

const v4 = (address: string): os.NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '',
  internal: false,
  cidr: `${address}/24`,
});

describe('usablePublicIpv4', () => {
  test('rejects fake-IP, CGNAT, LAN and non-v4', () => {
    expect(usablePublicIpv4('203.0.113.10')).toBe('203.0.113.10');
    expect(usablePublicIpv4('198.18.0.1')).toBeNull();
    expect(usablePublicIpv4('100.64.1.1')).toBeNull();
    expect(usablePublicIpv4('10.0.0.2')).toBeNull();
    expect(usablePublicIpv4('192.168.1.4')).toBeNull();
    expect(usablePublicIpv4('hostname.example')).toBeNull();
  });
});

describe('enumeratePeerEndpoints public IPv4', () => {
  const lan = { eth0: [v4('10.0.0.8')] };

  test('appends STUN mappedAddress after LAN when bind-all and IP is not local', () => {
    const urls = enumeratePeerEndpoints(39001, lan, {
      bindHosts: ['::', '0.0.0.0'],
      mappedAddresses: ['203.0.113.9:54321'],
    });
    expect(urls).toEqual(['ws://10.0.0.8:39001/peer', 'ws://203.0.113.9:39001/peer']);
  });

  test('VIBETERM_PEER_PUBLIC_HOST wins over mappedAddress', () => {
    const urls = enumeratePeerEndpoints(39001, lan, {
      bindHosts: ['0.0.0.0'],
      publicHost: '198.51.100.7',
      mappedAddresses: ['203.0.113.9:9'],
    });
    expect(urls.at(-1)).toBe('ws://198.51.100.7:39001/peer');
  });

  test('does not advertise fake-IP or CGNAT mapped addresses', () => {
    const urls = enumeratePeerEndpoints(39001, lan, {
      bindHosts: ['0.0.0.0'],
      mappedAddresses: ['198.18.1.2:9', '100.64.0.1:9'],
    });
    expect(urls).toEqual(['ws://10.0.0.8:39001/peer']);
  });

  test('skips public IP already on an interface', () => {
    const urls = enumeratePeerEndpoints(
      39001,
      { eth0: [v4('203.0.113.9')] },
      {
        bindHosts: ['0.0.0.0'],
        mappedAddresses: ['203.0.113.9:40000'],
      }
    );
    expect(urls).toEqual(['ws://203.0.113.9:39001/peer']);
  });

  test('does not advertise public IP when peer server is bound to a specific host', () => {
    const urls = enumeratePeerEndpoints(39001, lan, {
      bindHosts: ['127.0.0.1'],
      publicHost: '203.0.113.9',
    });
    expect(urls).toEqual(['ws://10.0.0.8:39001/peer']);
  });
});

describe('stunMappedAddressesForAdvertise TTL', () => {
  test('超过 30 min 的映射地址不再广播', () => {
    const now = 1_000_000_000;
    const rows = [
      { ok: true, mappedAddress: '203.0.113.9:54321', probedAt: now - 31 * 60 * 1000 },
      { ok: true, mappedAddress: '198.51.100.7:1000', probedAt: now - 60 * 1000 },
      { ok: true, mappedAddress: '192.0.2.5:2000' },
    ];
    expect(stunMappedAddressesForAdvertise(rows, now)).toEqual([
      '198.51.100.7:1000',
      '192.0.2.5:2000',
    ]);
  });
});
