import { describe, expect, test } from 'bun:test';
import type os from 'node:os';
import {
  STUN_MAPPED_ADVERTISE_MAX,
  advertisablePublicHost,
  enumeratePeerEndpoints,
  pickPublicPeerIpv4,
  pickRelayObservedIpv4,
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

  test('rejects reserved IPv4: 0/8, multicast, class E, broadcast', () => {
    expect(usablePublicIpv4('0.0.0.1')).toBeNull();
    expect(usablePublicIpv4('0.0.0.0')).toBeNull();
    expect(usablePublicIpv4('224.0.0.1')).toBeNull();
    expect(usablePublicIpv4('240.0.0.1')).toBeNull();
    expect(usablePublicIpv4('255.255.255.255')).toBeNull();
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

  test('appends an explicit public hostname', () => {
    const urls = enumeratePeerEndpoints(39001, lan, {
      bindHosts: ['0.0.0.0'],
      publicHost: 'tmexhub-sh.example.com',
    });
    expect(urls.at(-1)).toBe('ws://tmexhub-sh.example.com:39001/peer');
  });
});

describe('advertisablePublicHost', () => {
  test('accepts public IPv4 and FQDN, rejects LAN / fake-IP / IPv6', () => {
    expect(advertisablePublicHost('203.0.113.10')).toBe('203.0.113.10');
    expect(advertisablePublicHost(' tmexhub-sh.jiefakj.com ')).toBe('tmexhub-sh.jiefakj.com');
    expect(advertisablePublicHost('10.0.0.3')).toBeNull();
    expect(advertisablePublicHost('198.18.0.1')).toBeNull();
    expect(advertisablePublicHost('2001:db8::1')).toBeNull();
    expect(advertisablePublicHost('localhost')).toBeNull();
    expect(advertisablePublicHost('not a host')).toBeNull();
    expect(advertisablePublicHost('1.2.3.4.5')).toBeNull();
    expect(advertisablePublicHost('1.2.3')).toBeNull();
    expect(advertisablePublicHost('a.b')).toBe('a.b');
  });
});

describe('stunMappedAddressesForAdvertise', () => {
  const now = 1_000_000_000;

  test('超过 30 min 的映射地址不再广播', () => {
    const rows = [
      { ok: true, mappedAddress: '198.51.100.7:1', probedAt: now - 31 * 60 * 1000 },
      { ok: true, mappedAddress: '198.51.100.7:1000', probedAt: now - 60 * 1000 },
      { ok: true, mappedAddress: '198.51.100.7:2000' },
    ];
    expect(stunMappedAddressesForAdvertise(rows, now)).toEqual([
      '198.51.100.7:1000',
      '198.51.100.7:2000',
    ]);
  });

  test('过期样本不参与多数派，只剩一条新鲜样本时仍广告', () => {
    const rows = [
      { ok: true, mappedAddress: '203.0.113.9:1', probedAt: now - 31 * 60 * 1000 },
      { ok: true, mappedAddress: '198.51.100.7:1000', probedAt: now - 60 * 1000 },
    ];
    expect(stunMappedAddressesForAdvertise(rows, now)).toEqual(['198.51.100.7:1000']);
  });

  test('全体一致时广告该 IPv4，忽略 fakeIp', () => {
    const rows = [
      { ok: true, fakeIp: false, mappedAddress: '203.0.113.9:1' },
      { ok: true, fakeIp: true, mappedAddress: '203.0.113.9:2' },
      { ok: true, mappedAddress: '203.0.113.9:3' },
    ];
    expect(stunMappedAddressesForAdvertise(rows, now)).toEqual([
      '203.0.113.9:1',
      '203.0.113.9:2',
      '203.0.113.9:3',
    ]);
  });

  test('二比二分歧按地址稳定排序广告全部可用公网候选', () => {
    const rows = [
      { ok: true, fakeIp: true, mappedAddress: '152.70.84.203:3' },
      { ok: true, fakeIp: true, mappedAddress: '122.51.254.148:1' },
      { ok: true, fakeIp: true, mappedAddress: '152.70.84.203:4' },
      { ok: true, fakeIp: true, mappedAddress: '122.51.254.148:2' },
    ];
    expect(stunMappedAddressesForAdvertise(rows, now)).toEqual([
      '122.51.254.148:1',
      '152.70.84.203:3',
    ]);
    const urls = enumeratePeerEndpoints(
      39001,
      { eth0: [v4('10.0.0.3')] },
      {
        bindHosts: ['0.0.0.0'],
        mappedAddresses: stunMappedAddressesForAdvertise(rows, now),
      }
    );
    expect(urls).toEqual([
      'ws://10.0.0.3:39001/peer',
      'ws://122.51.254.148:39001/peer',
      'ws://152.70.84.203:39001/peer',
    ]);
  });

  test('两条可达且 1:1 分歧时两条都广告', () => {
    const rows = [
      { ok: true, mappedAddress: '198.51.100.7:1' },
      { ok: true, mappedAddress: '203.0.113.9:2' },
    ];
    expect(stunMappedAddressesForAdvertise(rows, now)).toEqual(['198.51.100.7:1', '203.0.113.9:2']);
  });

  test('三比一多数广告多数派', () => {
    const rows = [
      { ok: true, mappedAddress: '122.51.254.148:1' },
      { ok: true, mappedAddress: '122.51.254.148:2' },
      { ok: true, mappedAddress: '122.51.254.148:3' },
      { ok: true, mappedAddress: '152.70.84.203:4' },
    ];
    expect(stunMappedAddressesForAdvertise(rows, now)).toEqual([
      '122.51.254.148:1',
      '122.51.254.148:2',
      '122.51.254.148:3',
    ]);
  });

  test('只有一个有效样本时广告它', () => {
    const rows = [
      { ok: false, mappedAddress: '203.0.113.9:1' },
      { ok: true, mappedAddress: '198.51.100.7:2' },
    ];
    expect(stunMappedAddressesForAdvertise(rows, now)).toEqual(['198.51.100.7:2']);
  });

  test('无多数时最多广告 STUN_MAPPED_ADVERTISE_MAX 条不同 IPv4', () => {
    const rows = [
      { ok: true, mappedAddress: '198.51.100.4:4' },
      { ok: true, mappedAddress: '198.51.100.1:1' },
      { ok: true, mappedAddress: '198.51.100.3:3' },
      { ok: true, mappedAddress: '198.51.100.2:2' },
    ];
    expect(STUN_MAPPED_ADVERTISE_MAX).toBe(3);
    expect(stunMappedAddressesForAdvertise(rows, now)).toEqual([
      '198.51.100.1:1',
      '198.51.100.2:2',
      '198.51.100.3:3',
    ]);
  });

  test('全部不可用时不广告', () => {
    const rows = [
      { ok: false, mappedAddress: '203.0.113.9:1' },
      { ok: true, fakeIp: true },
      { ok: true, mappedAddress: '198.18.0.1:9' },
      { ok: true, mappedAddress: '10.0.0.3:9' },
      { ok: true, mappedAddress: '100.64.1.1:9' },
    ];
    expect(stunMappedAddressesForAdvertise(rows, now)).toEqual([]);
  });

  test('上海机 STUN 2:2 分裂 + 一条可用中继观测只广告真实公网', () => {
    const rows = [
      { ok: true, fakeIp: true, mappedAddress: '152.70.84.203:3' },
      { ok: true, fakeIp: true, mappedAddress: '122.51.254.148:1' },
      { ok: true, fakeIp: true, mappedAddress: '152.70.84.203:4' },
      { ok: true, fakeIp: true, mappedAddress: '122.51.254.148:2' },
    ];
    const mapped = stunMappedAddressesForAdvertise(rows, now);
    expect(mapped).toEqual(['122.51.254.148:1', '152.70.84.203:3']);
    const picks: string[] = [];
    const urls = enumeratePeerEndpoints(
      39001,
      { eth0: [v4('10.0.0.3')] },
      {
        bindHosts: ['0.0.0.0'],
        mappedAddresses: mapped,
        relayObserved: ['127.0.0.1', '122.51.254.148'],
        onPublicPick: (pick) => {
          picks.push(pick.source);
          expect(pick).toEqual({ hosts: ['122.51.254.148'], source: 'relay-observed' });
        },
      }
    );
    expect(urls).toEqual(['ws://10.0.0.3:39001/peer', 'ws://122.51.254.148:39001/peer']);
    expect(picks).toEqual(['relay-observed']);
    expect(
      pickPublicPeerIpv4({ mappedAddresses: mapped, relayObserved: ['122.51.254.148'] }, new Set())
    ).toEqual({ hosts: ['122.51.254.148'], source: 'relay-observed' });
  });

  test('TUN 代理机全部 fakeIp=true 且 mapped 一致时广告公网地址', () => {
    const rows = [
      { ok: true, fakeIp: true, mappedAddress: '122.51.254.148:53251' },
      { ok: true, fakeIp: true, mappedAddress: '122.51.254.148:51119' },
      { ok: true, fakeIp: true, mappedAddress: '122.51.254.148:37716' },
      { ok: true, fakeIp: true, mappedAddress: '122.51.254.148:38118' },
    ];
    expect(stunMappedAddressesForAdvertise(rows, now)).toEqual([
      '122.51.254.148:53251',
      '122.51.254.148:51119',
      '122.51.254.148:37716',
      '122.51.254.148:38118',
    ]);
    const urls = enumeratePeerEndpoints(
      39001,
      { eth0: [v4('10.0.0.3')] },
      {
        bindHosts: ['0.0.0.0'],
        mappedAddresses: stunMappedAddressesForAdvertise(rows, now),
      }
    );
    expect(urls).toEqual(['ws://10.0.0.3:39001/peer', 'ws://122.51.254.148:39001/peer']);
  });
});

describe('pickRelayObservedIpv4 / pickPublicPeerIpv4', () => {
  test('丢掉回环与私网，单条可用观测可以采用', () => {
    expect(pickRelayObservedIpv4(['127.0.0.1', '10.0.0.3'])).toBeNull();
    expect(pickRelayObservedIpv4(['127.0.0.1', '122.51.254.148'])).toBe('122.51.254.148');
  });

  test('多条观测多数派；1:1 平票不采用', () => {
    expect(pickRelayObservedIpv4(['122.51.254.148', '122.51.254.148', '152.70.84.203'])).toBe(
      '122.51.254.148'
    );
    expect(pickRelayObservedIpv4(['122.51.254.148', '152.70.84.203'])).toBeNull();
  });

  test('显式 publicHost 压过中继观测和 STUN', () => {
    expect(
      pickPublicPeerIpv4(
        {
          publicHost: '198.51.100.7',
          relayObserved: ['122.51.254.148'],
          mappedAddresses: ['203.0.113.9:1'],
        },
        new Set()
      )
    ).toEqual({ hosts: ['198.51.100.7'], source: 'explicit' });
  });

  test('中继观测平票时回落到 STUN 分裂', () => {
    expect(
      pickPublicPeerIpv4(
        {
          relayObserved: ['122.51.254.148', '152.70.84.203'],
          mappedAddresses: ['122.51.254.148:1', '152.70.84.203:2'],
        },
        new Set()
      )
    ).toEqual({
      hosts: ['122.51.254.148', '152.70.84.203'],
      source: 'stun-split',
    });
  });

  test('无观测无 STUN 时 source=none', () => {
    expect(pickPublicPeerIpv4({}, new Set())).toEqual({ hosts: [], source: 'none' });
  });
});
