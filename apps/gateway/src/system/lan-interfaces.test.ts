import { describe, expect, test } from 'bun:test';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  classifyLanCandidate,
  collectLanCandidates,
  isBridgeIface,
  isPhysicalIface,
  isVirtualIface,
  parseDarwinDefaultIface,
  parseLinuxDefaultIface,
} from './lan-interfaces';

const entry = (address: string, mac = ''): NetworkInterfaceInfo =>
  ({
    address,
    family: 'IPv4',
    internal: false,
    netmask: '',
    mac,
    cidr: null,
  }) as NetworkInterfaceInfo;

describe('lan-interfaces 网卡分类', () => {
  test('网卡名归类', () => {
    for (const name of ['en0', 'eth0', 'wlan0', 'enp3s0', 'ens160', 'wlp2s0', 'bond0']) {
      expect(isPhysicalIface(name)).toBe(true);
      expect(isVirtualIface(name)).toBe(false);
    }
    for (const name of ['utun4', 'tun0', 'tap0', 'wg0', 'docker0', 'br-abc', 'veth9', 'awdl0']) {
      expect(isVirtualIface(name)).toBe(true);
    }
    // 裸网桥不是虚拟网卡：物理网卡并进 br0 / bridge0 后局域网地址就挂在这里
    for (const name of ['br0', 'br1', 'bridge0', 'bridge100']) {
      expect(isBridgeIface(name)).toBe(true);
      expect(isVirtualIface(name)).toBe(false);
    }
    for (const name of ['br-abc123', 'virbr0', 'lxdbr0', 'lxcbr0']) {
      expect(isBridgeIface(name)).toBe(false);
      expect(isVirtualIface(name)).toBe(true);
    }
  });

  test('分类矩阵', () => {
    const cases: Array<[string, string, string | null]> = [
      ['en0', '192.168.1.20', 'lan'],
      ['eth0', '172.16.3.4', 'lan'],
      ['en0', '203.0.113.9', 'lan'],
      ['en0', '169.254.10.1', null],
      ['utun2', '198.18.0.1', null],
      ['en0', '198.19.255.1', null],
      ['utun4', '100.64.12.34', 'tailscale'],
      ['tailscale0', '100.100.1.1', 'tailscale'],
      ['en0', '100.70.0.1', 'tailscale'],
      ['utun0', '10.8.0.2', 'vpn'],
      ['ppp0', '192.168.30.2', 'vpn'],
      ['utun0', '203.0.113.7', null],
      ['docker0', '172.17.0.1', null],
      ['br0', '192.168.1.30', 'lan'],
      ['bridge100', '192.168.64.1', 'lan'],
      ['br0', '203.0.113.9', null],
      ['br-abc123', '172.18.0.1', null],
      ['vboxnet0', '192.168.56.1', null],
      ['anpi0', '10.1.2.3', null],
      ['thunderbolt0', '192.168.9.9', 'lan'],
      ['thunderbolt0', '203.0.113.5', null],
    ];
    for (const [iface, address, expected] of cases) {
      expect(`${iface} ${address} -> ${classifyLanCandidate({ iface, address })}`).toBe(
        `${iface} ${address} -> ${expected}`
      );
    }
  });

  test('网卡名不像物理网卡且 MAC 是虚拟化厂商前缀时丢弃，物理网卡不受 MAC 影响', () => {
    expect(
      classifyLanCandidate({ iface: 'vnic0', address: '10.2.2.2', mac: '00:50:56:aa:bb:cc' })
    ).toBeNull();
    expect(
      classifyLanCandidate({ iface: 'en5', address: '10.2.2.2', mac: '00:50:56:aa:bb:cc' })
    ).toBe('lan');
  });

  test('同一 IP 出现在多张网卡时只留优先级最高的那条', () => {
    const list = collectLanCandidates({
      utun9: [entry('10.5.5.5')],
      en0: [entry('10.5.5.5')],
    });
    expect(list).toEqual([{ ip: '10.5.5.5', kind: 'lan', iface: 'en0' }]);
  });

  test('回环与 IPv6 不进候选', () => {
    const list = collectLanCandidates({
      lo0: [{ ...entry('127.0.0.1'), internal: true } as NetworkInterfaceInfo],
      en0: [{ ...entry('fe80::1'), family: 'IPv6' } as NetworkInterfaceInfo],
    });
    expect(list).toEqual([]);
  });
});

describe('默认路由解析', () => {
  test('darwin route -n get default', () => {
    const output = [
      '   route to: default',
      'destination: default',
      '       mask: default',
      '  interface: en0',
      '      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>',
    ].join('\n');
    expect(parseDarwinDefaultIface(output)).toBe('en0');
    expect(parseDarwinDefaultIface('route: writing to routing socket: not in table')).toBeNull();
  });

  test('linux ip -4 route show default', () => {
    expect(
      parseLinuxDefaultIface(
        'default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.20 metric 100'
      )
    ).toBe('eth0');
    expect(parseLinuxDefaultIface('')).toBeNull();
  });
});
