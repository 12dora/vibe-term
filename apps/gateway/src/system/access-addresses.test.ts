import { describe, expect, test } from 'bun:test';
import type { NetworkInterfaceInfo } from 'node:os';
import { collectLanAddresses, getAccessAddresses, isLoopbackBindHost } from './access-addresses';
import { collectLanCandidates } from './lan-interfaces';

const iface = (
  address: string,
  family: 'IPv4' | 'IPv6' | 4 | 6 = 'IPv4',
  internal = false,
  mac = ''
): NetworkInterfaceInfo =>
  ({ address, family, internal, netmask: '', mac, cidr: null }) as unknown as NetworkInterfaceInfo;

describe('access-addresses', () => {
  test('回环监听地址识别（含 IPv6 与方括号）', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', '::1', '[::1]', 'localhost']) {
      expect(isLoopbackBindHost(host)).toBe(true);
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.2']) {
      expect(isLoopbackBindHost(host)).toBe(false);
    }
  });

  test('只收非回环 IPv4，跳过链路本地与代理 fake-IP，同一地址去重', () => {
    const list = collectLanAddresses({
      lo0: [iface('127.0.0.1', 'IPv4', true)],
      en0: [iface('192.168.1.20'), iface('fe80::1', 'IPv6')],
      utun: [iface('169.254.3.3'), iface('198.18.0.1')],
      en1: [iface('10.0.0.5'), iface('192.168.1.20')],
    });
    expect(list).toEqual(['192.168.1.20', '10.0.0.5']);
  });

  test('容器 / 虚拟机 / 桥接网卡上的私网地址不进候选', () => {
    const list = collectLanCandidates({
      docker0: [iface('172.17.0.1')],
      'br-abcdef': [iface('172.18.0.1')],
      veth1234: [iface('10.1.1.1')],
      vmnet8: [iface('192.168.55.1')],
      bridge100: [iface('192.168.64.1')],
      en0: [iface('192.168.1.20')],
    });
    expect(list).toEqual([{ ip: '192.168.1.20', kind: 'lan', iface: 'en0' }]);
  });

  test('Tailscale 的 CGNAT 地址保留但另标一类，排在物理局域网之后', () => {
    const list = collectLanCandidates({
      utun4: [iface('100.64.12.34')],
      en0: [iface('192.168.1.1')],
    });
    expect(list).toEqual([
      { ip: '192.168.1.1', kind: 'lan', iface: 'en0' },
      { ip: '100.64.12.34', kind: 'tailscale', iface: 'utun4' },
    ]);
  });

  test('隧道网卡上的私网地址标成 VPN，排在物理局域网与 Tailscale 之后', () => {
    const list = collectLanCandidates({
      utun0: [iface('10.8.0.2')],
      wg0: [iface('10.9.0.2')],
      utun4: [iface('100.64.12.34')],
      en0: [iface('192.168.1.1')],
    });
    expect(list.map((item) => [item.ip, item.kind])).toEqual([
      ['192.168.1.1', 'lan'],
      ['100.64.12.34', 'tailscale'],
      ['10.8.0.2', 'vpn'],
      ['10.9.0.2', 'vpn'],
    ]);
  });

  test('默认路由所在物理网卡排第一', () => {
    const interfaces = {
      en1: [iface('10.0.0.5')],
      en0: [iface('192.168.1.20')],
    };
    expect(collectLanCandidates(interfaces, { defaultIface: 'en1' })[0]?.ip).toBe('10.0.0.5');
    expect(collectLanCandidates(interfaces, { defaultIface: 'en0' })[0]?.ip).toBe('192.168.1.20');
  });

  test('默认路由被代理接管到 utun 时不抬升 VPN 地址', () => {
    const list = collectLanCandidates(
      {
        utun3: [iface('10.8.0.2')],
        en0: [iface('192.168.1.20')],
      },
      { defaultIface: 'utun3' }
    );
    expect(list[0]).toEqual({ ip: '192.168.1.20', kind: 'lan', iface: 'en0' });
  });

  test('绑定到具体 IPv4 时只列该地址', () => {
    const list = collectLanCandidates(
      {
        en0: [iface('192.168.1.20')],
        en1: [iface('10.0.0.5')],
      },
      { bindHost: '192.168.1.20' }
    );
    expect(list).toEqual([{ ip: '192.168.1.20', kind: 'lan', iface: 'en0' }]);
  });

  test('family 数值 4 与字符串 IPv4 同等对待', () => {
    expect(collectLanAddresses({ en0: [iface('192.168.1.20', 4)] })).toEqual(['192.168.1.20']);
  });

  test('只监听回环时不列局域网地址', () => {
    const res = getAccessAddresses({
      bindHost: '127.0.0.1',
      port: 9883,
      interfaces: () => ({ en0: [iface('192.168.1.20')] }),
      defaultIface: () => null,
    });
    expect(res).toEqual({
      bindHost: '127.0.0.1',
      port: 9883,
      loopbackOnly: true,
      lanAddresses: [],
      lanCandidates: [],
      relayAccessUrl: null,
    });
  });

  test('监听 0.0.0.0 时给出局域网候选，lanAddresses 由候选派生', () => {
    const res = getAccessAddresses({
      bindHost: '0.0.0.0',
      port: 9883,
      interfaces: () => ({ en0: [iface('192.168.1.20')], utun4: [iface('100.64.1.2')] }),
      defaultIface: () => null,
    });
    expect(res.loopbackOnly).toBe(false);
    expect(res.lanAddresses).toEqual(['192.168.1.20', '100.64.1.2']);
    expect(res.lanCandidates.map((item) => item.kind)).toEqual(['lan', 'tailscale']);
  });

  test('中继入口探通时随响应下发，探测抛错按不可用处理', () => {
    const base = {
      bindHost: '0.0.0.0',
      port: 9883,
      interfaces: () => ({}),
      defaultIface: () => null,
    };
    expect(
      getAccessAddresses({ ...base, relayAccessUrl: () => 'https://relay.example/n/abc' })
        .relayAccessUrl
    ).toBe('https://relay.example/n/abc');
    expect(
      getAccessAddresses({
        ...base,
        relayAccessUrl: () => {
          throw new Error('db closed');
        },
      }).relayAccessUrl
    ).toBeNull();
  });
});
