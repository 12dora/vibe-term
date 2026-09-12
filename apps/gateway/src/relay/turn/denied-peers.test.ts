import { describe, expect, test } from 'bun:test';
import { DEFAULT_DENIED_PEER_CIDRS, createPeerPolicy, normalizePeerAddress } from './denied-peers';

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
