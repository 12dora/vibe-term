import { describe, expect, test } from 'bun:test';
import {
  defaultPortForUrl,
  hostMatchesNoProxy,
  isPrivateLiteralHost,
  parseNoProxyToken,
  shouldBypassProxy,
  stripHostBrackets,
  urlMatchesNoProxy,
} from './mesh-egress-noproxy';

describe('NO_PROXY matcher', () => {
  test('stripHostBrackets 去掉一层方括号', () => {
    expect(stripHostBrackets('[::1]')).toBe('::1');
    expect(stripHostBrackets('::1')).toBe('::1');
    expect(stripHostBrackets('example.com')).toBe('example.com');
  });

  test('* 匹配任意主机', () => {
    expect(hostMatchesNoProxy('example.com', 443, '*')).toBe(true);
    expect(hostMatchesNoProxy('[::1]', 80, '*')).toBe(true);
  });

  test('括号 IPv6 与无括号 token 互相匹配', () => {
    expect(hostMatchesNoProxy('[::1]', 443, '::1')).toBe(true);
    expect(hostMatchesNoProxy('::1', 443, '[::1]')).toBe(true);
    expect(hostMatchesNoProxy('[2001:db8::1]', 443, '::1')).toBe(false);
  });

  test('带端口的 token 只匹配该端口', () => {
    expect(hostMatchesNoProxy('example.com', 8080, 'example.com:8080')).toBe(true);
    expect(hostMatchesNoProxy('example.com', 443, 'example.com:8080')).toBe(false);
    expect(hostMatchesNoProxy('[::1]', 443, '[::1]:443')).toBe(true);
    expect(hostMatchesNoProxy('[::1]', 80, '[::1]:443')).toBe(false);
  });

  test('前导点后缀匹配域名及其子域', () => {
    expect(hostMatchesNoProxy('example.com', 443, '.example.com')).toBe(true);
    expect(hostMatchesNoProxy('a.example.com', 443, '.example.com')).toBe(true);
    expect(hostMatchesNoProxy('notexample.com', 443, '.example.com')).toBe(false);
  });

  test('无前导点也匹配子域', () => {
    expect(hostMatchesNoProxy('a.example.com', 443, 'example.com')).toBe(true);
    expect(hostMatchesNoProxy('example.com', 443, 'example.com')).toBe(true);
  });

  test('IPv6 多冒号 token 不当成 host:port', () => {
    expect(parseNoProxyToken('2001:db8::1')).toEqual({ host: '2001:db8::1', port: null });
    expect(hostMatchesNoProxy('2001:db8::1', 443, '2001:db8::1')).toBe(true);
  });

  test('urlMatchesNoProxy 用协议默认端口', () => {
    expect(urlMatchesNoProxy(new URL('https://example.com/x'), 'example.com:443')).toBe(true);
    expect(urlMatchesNoProxy(new URL('wss://example.com/x'), 'example.com:443')).toBe(true);
    expect(urlMatchesNoProxy(new URL('http://[::1]/'), '::1')).toBe(true);
    expect(defaultPortForUrl(new URL('http://h.example'))).toBe(80);
  });

  test('逗号与空白分隔', () => {
    expect(hostMatchesNoProxy('a.example', 80, 'localhost, a.example  other.example')).toBe(true);
  });

  test('CIDR 匹配 IPv4 / IPv6，含括号与 mapped', () => {
    expect(hostMatchesNoProxy('10.1.2.3', 80, '10.0.0.0/8')).toBe(true);
    expect(hostMatchesNoProxy('11.0.0.1', 80, '10.0.0.0/8')).toBe(false);
    expect(hostMatchesNoProxy('192.168.1.20', 39001, '192.168.1.0/24')).toBe(true);
    expect(hostMatchesNoProxy('192.168.2.1', 39001, '192.168.1.0/24')).toBe(false);
    expect(hostMatchesNoProxy('8.8.8.8', 443, '8.8.8.0/24')).toBe(true);
    expect(hostMatchesNoProxy('[2001:db8::1]', 443, '2001:db8::/32')).toBe(true);
    expect(hostMatchesNoProxy('2001:db8:1::1', 443, '2001:db8::/32')).toBe(true);
    expect(hostMatchesNoProxy('2001:db9::1', 443, '2001:db8::/32')).toBe(false);
    expect(hostMatchesNoProxy('[::ffff:10.9.8.7]', 80, '10.0.0.0/8')).toBe(true);
    expect(parseNoProxyToken('10.0.0.0/8')).toEqual({
      cidr: { version: 4, ip: 0x0a000000, prefix: 8 },
    });
  });
});

describe('isPrivateLiteralHost', () => {
  test('环回 / RFC1918 / CGNAT / 链路本地 / ULA 为真', () => {
    expect(isPrivateLiteralHost('127.0.0.1')).toBe(true);
    expect(isPrivateLiteralHost('127.4.5.6')).toBe(true);
    expect(isPrivateLiteralHost('[::1]')).toBe(true);
    expect(isPrivateLiteralHost('::1')).toBe(true);
    expect(isPrivateLiteralHost('10.0.0.148')).toBe(true);
    expect(isPrivateLiteralHost('10.20.30.40')).toBe(true);
    expect(isPrivateLiteralHost('192.168.1.20')).toBe(true);
    expect(isPrivateLiteralHost('172.16.0.1')).toBe(true);
    expect(isPrivateLiteralHost('172.31.255.255')).toBe(true);
    expect(isPrivateLiteralHost('100.64.0.1')).toBe(true);
    expect(isPrivateLiteralHost('100.64.1.2')).toBe(true);
    expect(isPrivateLiteralHost('100.127.255.255')).toBe(true);
    expect(isPrivateLiteralHost('169.254.1.1')).toBe(true);
    expect(isPrivateLiteralHost('[fe80::1]')).toBe(true);
    expect(isPrivateLiteralHost('[fd12::1]')).toBe(true);
    expect(isPrivateLiteralHost('[fc00::1]')).toBe(true);
    expect(isPrivateLiteralHost('[::ffff:10.0.0.1]')).toBe(true);
    expect(isPrivateLiteralHost('[::ffff:100.64.1.2]')).toBe(true);
  });

  test('公网字面量与域名不为私网', () => {
    expect(isPrivateLiteralHost('8.8.8.8')).toBe(false);
    expect(isPrivateLiteralHost('172.32.0.1')).toBe(false);
    expect(isPrivateLiteralHost('100.63.255.255')).toBe(false);
    expect(isPrivateLiteralHost('100.128.0.1')).toBe(false);
    expect(isPrivateLiteralHost('[2001:db8::1]')).toBe(false);
    expect(isPrivateLiteralHost('relay.example')).toBe(false);
    expect(isPrivateLiteralHost('localhost')).toBe(false);
  });
});

describe('shouldBypassProxy', () => {
  test('私网字面量即使 NO_PROXY 为空也绕过', () => {
    expect(shouldBypassProxy(new URL('ws://100.64.1.2:39001/'), '')).toBe(true);
    expect(shouldBypassProxy(new URL('http://192.168.1.20:39001/'), '')).toBe(true);
    expect(shouldBypassProxy(new URL('ws://[::1]:39001/'), '')).toBe(true);
    expect(shouldBypassProxy(new URL('https://relay.example/x'), '')).toBe(false);
  });

  test('公网字面量靠 NO_PROXY / CIDR / 括号 IPv6 绕过', () => {
    const v6 = new URL('https://[2001:db8::1]/health');
    expect(shouldBypassProxy(v6, '')).toBe(false);
    expect(shouldBypassProxy(v6, '::1')).toBe(false);
    expect(shouldBypassProxy(v6, '2001:db8::1')).toBe(true);
    expect(shouldBypassProxy(v6, '[2001:db8::1]')).toBe(true);
    expect(shouldBypassProxy(new URL('http://8.8.8.8/'), '8.8.8.0/24')).toBe(true);
    expect(shouldBypassProxy(new URL('http://8.8.4.4/'), '8.8.8.0/24')).toBe(false);
    expect(shouldBypassProxy(new URL('https://relay.example/'), 'relay.example')).toBe(true);
  });
});
