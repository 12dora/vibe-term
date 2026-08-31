import { describe, expect, test } from 'bun:test';
import { collectLanAddresses, getAccessAddresses, isLoopbackBindHost } from './access-addresses';

const iface = (address: string, family: 'IPv4' | 'IPv6' = 'IPv4', internal = false) => ({
  address,
  family,
  internal,
  netmask: '',
  mac: '',
  cidr: null,
});

describe('access-addresses', () => {
  test('回环监听地址识别（含 IPv6 与方括号）', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', '::1', '[::1]', 'localhost']) {
      expect(isLoopbackBindHost(host)).toBe(true);
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.2']) {
      expect(isLoopbackBindHost(host)).toBe(false);
    }
  });

  test('只收非回环 IPv4，跳过链路本地，私网段排前并去重', () => {
    const list = collectLanAddresses({
      lo0: [iface('127.0.0.1', 'IPv4', true)],
      en0: [iface('192.168.1.20'), iface('fe80::1', 'IPv6')],
      utun: [iface('169.254.3.3'), iface('198.18.0.1')],
      en1: [iface('10.0.0.5'), iface('192.168.1.20')],
    });
    expect(list).toEqual(['10.0.0.5', '192.168.1.20', '198.18.0.1']);
  });

  test('只监听回环时不列局域网地址', () => {
    const res = getAccessAddresses({
      bindHost: '127.0.0.1',
      port: 9883,
      interfaces: () => ({ en0: [iface('192.168.1.20')] }),
    });
    expect(res).toEqual({
      bindHost: '127.0.0.1',
      port: 9883,
      loopbackOnly: true,
      lanAddresses: [],
    });
  });

  test('监听 0.0.0.0 时给出局域网地址', () => {
    const res = getAccessAddresses({
      bindHost: '0.0.0.0',
      port: 9883,
      interfaces: () => ({ en0: [iface('192.168.1.20')] }),
    });
    expect(res.loopbackOnly).toBe(false);
    expect(res.lanAddresses).toEqual(['192.168.1.20']);
  });
});
