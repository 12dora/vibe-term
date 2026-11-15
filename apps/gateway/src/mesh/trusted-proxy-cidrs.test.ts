import { describe, expect, test } from 'bun:test';
import { EMPTY_CIDR_SET, parseTrustedProxyCidrs } from './trusted-proxy-cidrs';

describe('parseTrustedProxyCidrs', () => {
  test('empty and whitespace-only default to an empty set', () => {
    expect(parseTrustedProxyCidrs(undefined)).toBe(EMPTY_CIDR_SET);
    expect(parseTrustedProxyCidrs('')).toBe(EMPTY_CIDR_SET);
    expect(parseTrustedProxyCidrs('  ,  ')).toBe(EMPTY_CIDR_SET);
  });

  test('accepts comma or whitespace separated IPv4/IPv6 CIDRs; bare address is host route', () => {
    const set = parseTrustedProxyCidrs('203.0.113.0/24\n2001:db8::/32, 198.51.100.7');
    expect(set.contains('203.0.113.1')).toBe(true);
    expect(set.contains('203.0.113.255')).toBe(true);
    expect(set.contains('198.51.100.7')).toBe(true);
    expect(set.contains('198.51.100.8')).toBe(false);
    expect(set.contains('2001:db8::ffff')).toBe(true);
    expect(set.contains('2001:db9::1')).toBe(false);
    expect(set.contains('::ffff:203.0.113.9')).toBe(true);
  });

  test('rejects invalid entries and names the bad token', () => {
    expect(() => parseTrustedProxyCidrs('nope')).toThrow(
      'VIBETERM_TRUSTED_PROXY_CIDRS contains invalid CIDR nope'
    );
    expect(() => parseTrustedProxyCidrs('203.0.113.0/24, 10.0.0.0/33')).toThrow(
      'VIBETERM_TRUSTED_PROXY_CIDRS contains invalid CIDR 10.0.0.0/33'
    );
    expect(() => parseTrustedProxyCidrs('2001:db8::/129')).toThrow(
      'VIBETERM_TRUSTED_PROXY_CIDRS contains invalid CIDR 2001:db8::/129'
    );
    for (const bad of [
      '203.0.113.0/',
      '2001:db8::/',
      '10.0.0.0/0x8',
      '10.0.0.0/+8',
      '10.0.0.0/08',
    ]) {
      expect(() => parseTrustedProxyCidrs(bad)).toThrow(
        `VIBETERM_TRUSTED_PROXY_CIDRS contains invalid CIDR ${bad}`
      );
    }
  });
});
