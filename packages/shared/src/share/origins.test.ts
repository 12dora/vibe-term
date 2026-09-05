import { describe, expect, test } from 'bun:test';
import { isPublicShareOrigin, normalizeShareOrigin, rankShareOrigins } from './origins';
import type { ShareOriginCandidate } from './types';

describe('isPublicShareOrigin', () => {
  test('公网域名与公网 IP 通过', () => {
    for (const url of [
      'https://tmex.example.com',
      'http://example.co.jp:8443',
      'https://203.0.113.9',
      'https://[2001:db8::1]',
      'https://8.8.8.8:9663',
      'https://[::ffff:8.8.8.8]',
    ]) {
      expect(isPublicShareOrigin(url)).toBe(true);
    }
  });

  test('内网 IPv4 / 回环 / 链路本地 / CGNAT 全部拒绝', () => {
    for (const url of [
      'http://127.0.0.1:9663',
      'http://10.0.0.5',
      'http://172.16.0.1',
      'http://172.31.255.254',
      'http://192.168.1.10',
      'http://169.254.1.1',
      'http://100.64.0.1',
      'http://100.127.255.255',
      'http://0.0.0.0',
      'http://239.1.1.1',
      'http://[::ffff:192.168.0.1]',
    ]) {
      expect(isPublicShareOrigin(url)).toBe(false);
    }
  });

  test('172.15 / 172.32 与 100.63 / 100.128 属于公网', () => {
    expect(isPublicShareOrigin('http://172.15.0.1')).toBe(true);
    expect(isPublicShareOrigin('http://172.32.0.1')).toBe(true);
    expect(isPublicShareOrigin('http://100.63.0.1')).toBe(true);
    expect(isPublicShareOrigin('http://100.128.0.1')).toBe(true);
  });

  test('localhost / .local / 裸主机名拒绝', () => {
    expect(isPublicShareOrigin('http://localhost:9663')).toBe(false);
    expect(isPublicShareOrigin('http://mac.local')).toBe(false);
    expect(isPublicShareOrigin('http://mac.local.')).toBe(false);
    expect(isPublicShareOrigin('http://myhost')).toBe(false);
    expect(isPublicShareOrigin('http://app.localhost')).toBe(false);
  });

  test('IPv6 回环 / ULA / 链路本地拒绝', () => {
    expect(isPublicShareOrigin('http://[::1]:9663')).toBe(false);
    expect(isPublicShareOrigin('http://[::]')).toBe(false);
    expect(isPublicShareOrigin('http://[fd00::1]')).toBe(false);
    expect(isPublicShareOrigin('http://[fc00::1]')).toBe(false);
    expect(isPublicShareOrigin('http://[fe80::1]')).toBe(false);
    expect(isPublicShareOrigin('http://[fec0::1]')).toBe(false);
  });

  test('非 http(s) 与非法输入拒绝', () => {
    expect(isPublicShareOrigin('ws://example.com')).toBe(false);
    expect(isPublicShareOrigin('file:///tmp/x')).toBe(false);
    expect(isPublicShareOrigin('not a url')).toBe(false);
    expect(isPublicShareOrigin('')).toBe(false);
  });
});

describe('normalizeShareOrigin', () => {
  test('去掉尾部斜杠，保留端口与路径前缀', () => {
    expect(normalizeShareOrigin('https://a.example.com/')).toBe('https://a.example.com');
    expect(normalizeShareOrigin('https://a.example.com:8443//')).toBe('https://a.example.com:8443');
    expect(normalizeShareOrigin('https://hub.example.com/n/abc/')).toBe(
      'https://hub.example.com/n/abc'
    );
    expect(normalizeShareOrigin('nope')).toBeNull();
  });
});

describe('rankShareOrigins', () => {
  const candidate = (url: string, kind: ShareOriginCandidate['kind']): ShareOriginCandidate => ({
    url,
    kind,
    label: kind,
  });

  test('按 custom > site > hub > relay > tunnel > ip 排序', () => {
    const ranked = rankShareOrigins([
      candidate('https://ip.example.com', 'ip'),
      candidate('https://tunnel.example.com', 'tunnel'),
      candidate('https://relay.example.com', 'relay'),
      candidate('https://hub.example.com', 'hub'),
      candidate('https://site.example.com', 'site'),
      candidate('https://custom.example.com', 'custom'),
    ]);
    expect(ranked.map((entry) => entry.kind)).toEqual([
      'custom',
      'site',
      'hub',
      'relay',
      'tunnel',
      'ip',
    ]);
  });

  test('同 kind 保持传入顺序', () => {
    const ranked = rankShareOrigins([
      candidate('https://h2.example.com', 'hub'),
      candidate('https://h1.example.com', 'hub'),
    ]);
    expect(ranked.map((entry) => entry.url)).toEqual([
      'https://h2.example.com',
      'https://h1.example.com',
    ]);
  });

  test('过滤内网地址并去重', () => {
    const ranked = rankShareOrigins([
      candidate('http://192.168.1.9:9663', 'ip'),
      candidate('http://localhost:9663', 'site'),
      candidate('https://a.example.com/', 'site'),
      candidate('https://a.example.com', 'hub'),
    ]);
    expect(ranked).toEqual([{ url: 'https://a.example.com', kind: 'site', label: 'site' }]);
  });

  test('空输入返回空数组', () => {
    expect(rankShareOrigins([])).toEqual([]);
  });
});
