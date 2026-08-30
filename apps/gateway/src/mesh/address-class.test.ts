import { describe, expect, test } from 'bun:test';
import {
  addressFromIceCandidate,
  classifyPeerReach,
  classifyRemoteAddress,
  hostFromWsUrl,
  isPeerReachable,
  parseIpv6Words,
  rttChangedMaterially,
} from './address-class';

describe('classifyRemoteAddress', () => {
  test('treats missing or unparsable input as wan', () => {
    expect(classifyRemoteAddress(null)).toBe('wan');
    expect(classifyRemoteAddress(undefined)).toBe('wan');
    expect(classifyRemoteAddress('')).toBe('wan');
    expect(classifyRemoteAddress('unknown')).toBe('wan');
    expect(classifyRemoteAddress('example.com')).toBe('wan');
  });

  test('classifies loopback as lan', () => {
    expect(classifyRemoteAddress('127.0.0.1')).toBe('lan');
    expect(classifyRemoteAddress('127.1.2.3')).toBe('lan');
    expect(classifyRemoteAddress('::1')).toBe('lan');
    expect(classifyRemoteAddress('[::1]')).toBe('lan');
    expect(classifyRemoteAddress('localhost')).toBe('lan');
    expect(classifyRemoteAddress('LOCALHOST')).toBe('lan');
  });

  test('classifies RFC1918 as lan', () => {
    expect(classifyRemoteAddress('10.0.0.1')).toBe('lan');
    expect(classifyRemoteAddress('10.255.255.254')).toBe('lan');
    expect(classifyRemoteAddress('172.16.0.1')).toBe('lan');
    expect(classifyRemoteAddress('172.31.255.1')).toBe('lan');
    expect(classifyRemoteAddress('192.168.1.1')).toBe('lan');
  });

  test('rejects adjacent public ranges that look like RFC1918', () => {
    expect(classifyRemoteAddress('172.15.0.1')).toBe('wan');
    expect(classifyRemoteAddress('172.32.0.1')).toBe('wan');
    expect(classifyRemoteAddress('11.0.0.1')).toBe('wan');
    expect(classifyRemoteAddress('192.169.0.1')).toBe('wan');
  });

  test('classifies link-local and IPv6 ULA as lan', () => {
    expect(classifyRemoteAddress('169.254.1.1')).toBe('lan');
    expect(classifyRemoteAddress('fe80::1')).toBe('lan');
    expect(classifyRemoteAddress('fe80::1%en0')).toBe('lan');
    expect(classifyRemoteAddress('fc00::1')).toBe('lan');
    expect(classifyRemoteAddress('fd12:3456:789a::1')).toBe('lan');
  });

  test('classifies IPv4-mapped private forms as lan', () => {
    expect(classifyRemoteAddress('::ffff:127.0.0.1')).toBe('lan');
    expect(classifyRemoteAddress('::ffff:10.1.2.3')).toBe('lan');
    expect(classifyRemoteAddress('::ffff:c0a8:0101')).toBe('lan');
    expect(classifyRemoteAddress('::ffff:ac10:0001')).toBe('lan');
  });

  test('classifies public addresses as wan', () => {
    expect(classifyRemoteAddress('203.0.113.10')).toBe('wan');
    expect(classifyRemoteAddress('8.8.8.8')).toBe('wan');
    expect(classifyRemoteAddress('2001:db8::1')).toBe('wan');
    expect(classifyRemoteAddress('::ffff:203.0.113.10')).toBe('wan');
  });
});

describe('classifyPeerReach', () => {
  test('relay transport is always relay regardless of address', () => {
    expect(classifyPeerReach('relay', '10.0.0.1')).toBe('relay');
    expect(classifyPeerReach('relay', '8.8.8.8')).toBe('relay');
    expect(classifyPeerReach('relay', null)).toBe('relay');
  });

  test('ws-secure and dc follow the remote address; unknown address is wan', () => {
    expect(classifyPeerReach('ws-secure', '192.168.0.9')).toBe('lan');
    expect(classifyPeerReach('ws-secure', '203.0.113.9')).toBe('wan');
    expect(classifyPeerReach('ws-secure', null)).toBe('wan');
    expect(classifyPeerReach('dc', '10.0.0.2')).toBe('lan');
    expect(classifyPeerReach('dc', null)).toBe('wan');
    expect(classifyPeerReach(null, '10.0.0.2')).toBeNull();
  });
});

describe('isPeerReachable', () => {
  test('lan wan and relay count as online; null does not', () => {
    expect(isPeerReachable('lan')).toBe(true);
    expect(isPeerReachable('wan')).toBe(true);
    expect(isPeerReachable('relay')).toBe(true);
    expect(isPeerReachable(null)).toBe(false);
    expect(isPeerReachable(undefined)).toBe(false);
  });
});

describe('rttChangedMaterially', () => {
  test('null to a number is material; identical values are not', () => {
    expect(rttChangedMaterially(null, 12)).toBe(true);
    expect(rttChangedMaterially(12, null)).toBe(true);
    expect(rttChangedMaterially(null, null)).toBe(false);
    expect(rttChangedMaterially(40, 40)).toBe(false);
  });

  test('emits when delta is at least 10ms or 20 percent of previous', () => {
    expect(rttChangedMaterially(100, 108)).toBe(false);
    expect(rttChangedMaterially(100, 120)).toBe(true);
    expect(rttChangedMaterially(8, 11)).toBe(true);
    expect(rttChangedMaterially(50, 61)).toBe(true);
  });
});

describe('parseIpv6Words', () => {
  test('expands compressed groups and lowercases', () => {
    expect(parseIpv6Words('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6Words('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6Words('2001:db8::8')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 8]);
    expect(parseIpv6Words('FE80::1')).toEqual(parseIpv6Words('fe80::1'));
    expect(parseIpv6Words('2001:0db8:0000:0000:0000:0000:0000:0001')).toEqual([
      0x2001, 0xdb8, 0, 0, 0, 0, 0, 1,
    ]);
    expect(parseIpv6Words('1:2:3:4:5:6:7:8::')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('strips zone-id before expanding so scoped and bare forms match', () => {
    expect(parseIpv6Words('fe80::1%en0')).toEqual(parseIpv6Words('fe80::1'));
    expect(parseIpv6Words('2001:db8::8%eth0')).toEqual(parseIpv6Words('2001:db8::8'));
    expect(parseIpv6Words('::1%lo0')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });

  test('rejects malformed, dotted, and over-compressed input', () => {
    expect(parseIpv6Words('')).toBeNull();
    expect(parseIpv6Words(':::1')).toBeNull();
    expect(parseIpv6Words('1::2::3')).toBeNull();
    expect(parseIpv6Words('gggg::1')).toBeNull();
    expect(parseIpv6Words('2001:db8::1.2.3.4')).toBeNull();
    expect(parseIpv6Words('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIpv6Words('::ffff:10.1.2.3')).toBeNull();
  });
});

describe('hostFromWsUrl and addressFromIceCandidate', () => {
  test('extracts hostname from peer websocket urls', () => {
    expect(hostFromWsUrl('ws://127.0.0.1:39001/peer')).toBe('127.0.0.1');
    expect(hostFromWsUrl('ws://[::1]:39001/peer')).toBe('::1');
    expect(hostFromWsUrl('wss://203.0.113.8:443/peer')).toBe('203.0.113.8');
    expect(hostFromWsUrl('not a url')).toBeNull();
  });

  test('extracts the ip before typ in an ICE candidate line', () => {
    expect(addressFromIceCandidate('candidate:1 1 UDP 1 10.0.1.55 9 typ host')).toBe('10.0.1.55');
    expect(addressFromIceCandidate('candidate:2 1 UDP 1 203.0.113.44 3478 typ srflx')).toBe(
      '203.0.113.44'
    );
    expect(addressFromIceCandidate('candidate:1 1 UDP 1 2001:db8::1 9 typ host')).toBe(
      '2001:db8::1'
    );
    expect(addressFromIceCandidate('')).toBeNull();
  });
});
