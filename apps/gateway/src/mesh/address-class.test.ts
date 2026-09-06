import { describe, expect, test } from 'bun:test';
import {
  type RankableIfaceAddr,
  addressFromIceCandidate,
  canonicalPeerHost,
  classifyPeerReach,
  classifyRemoteAddress,
  hasLocalCgnatAddress,
  hostFromWsUrl,
  isCgnatIpv4,
  isIpAddressLiteral,
  isIpv4DottedLiteral,
  isIpv6Literal,
  isIpv6SiteLocal,
  isIpv6Ula,
  isLoopbackClientIp,
  isLoopbackHostLiteral,
  isPeerReachable,
  localNetworkFingerprint,
  looksLikeIpv6,
  parseIpLiteral,
  parseIpv6Words,
  rankPeerEndpoints,
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

describe('CGNAT / ULA helpers and local fingerprint', () => {
  test('classifies RFC 6598 and IPv6 ULA / site-local', () => {
    expect(isCgnatIpv4('100.64.0.1')).toBe(true);
    expect(isCgnatIpv4('100.127.255.255')).toBe(true);
    expect(isCgnatIpv4('100.63.255.255')).toBe(false);
    expect(isCgnatIpv4('100.128.0.1')).toBe(false);
    expect(isCgnatIpv4('::ffff:100.64.1.2')).toBe(true);
    expect(isIpv6Ula('fc00::1')).toBe(true);
    expect(isIpv6Ula('fd12:3456:789a::1')).toBe(true);
    expect(isIpv6Ula('fe80::1')).toBe(false);
    expect(isIpv6SiteLocal('fec0::1')).toBe(true);
    expect(isIpv6SiteLocal('fe80::1')).toBe(false);
    expect(canonicalPeerHost('::ffff:10.0.0.1')).toBe('10.0.0.1');
  });

  test('fingerprint is the sorted unique non-internal address set', () => {
    const ifaces = {
      lo0: [{ address: '127.0.0.1', internal: true, family: 'IPv4' }],
      en0: [
        { address: '10.0.0.8', internal: false, family: 'IPv4' },
        { address: '10.0.0.8', internal: false, family: 'IPv4' },
      ],
      en1: [{ address: '192.168.1.1', internal: false, family: 'IPv4' }],
    };
    expect(localNetworkFingerprint(ifaces)).toBe('10.0.0.8,192.168.1.1');
    expect(hasLocalCgnatAddress(ifaces)).toBe(false);
    expect(
      hasLocalCgnatAddress({
        utun4: [{ address: '100.64.1.1', internal: false, family: 'IPv4' }],
      })
    ).toBe(true);
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

describe('rankPeerEndpoints', () => {
  const lan: RankableIfaceAddr = {
    address: '10.77.88.10',
    netmask: '255.255.255.0',
    family: 'IPv4',
    internal: false,
    cidr: '10.77.88.10/24',
  };
  const loopback: RankableIfaceAddr = {
    address: '127.0.0.1',
    netmask: '255.0.0.0',
    family: 'IPv4',
    internal: true,
    cidr: '127.0.0.1/8',
  };
  const v6ula: RankableIfaceAddr = {
    address: 'fd12:3456:789a::10',
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    internal: false,
    cidr: 'fd12:3456:789a::10/64',
  };

  test('orders same-subnet before other private before public, IPv4 before IPv6', () => {
    const ranked = rankPeerEndpoints(
      [
        'ws://4.2.2.1:39001/peer',
        'ws://172.17.0.1:39001/peer',
        'ws://[2001:db8::1]:39001/peer',
        'ws://[fd00::9]:39001/peer',
        'ws://10.77.88.3:39001/peer',
      ],
      { en0: [lan], lo0: [loopback] }
    );
    expect(ranked).toEqual([
      'ws://10.77.88.3:39001/peer',
      'ws://172.17.0.1:39001/peer',
      'ws://[fd00::9]:39001/peer',
      'ws://4.2.2.1:39001/peer',
      'ws://[2001:db8::1]:39001/peer',
    ]);
  });

  test('ignores internal interfaces when deciding same-subnet', () => {
    const ranked = rankPeerEndpoints(['ws://127.0.0.1:39001/peer', 'ws://10.77.88.3:39001/peer'], {
      en0: [lan],
      lo0: [loopback],
    });
    expect(ranked).toEqual(['ws://10.77.88.3:39001/peer', 'ws://127.0.0.1:39001/peer']);
  });

  test('ranks IPv6 same-subnet ahead of other private v4', () => {
    const ranked = rankPeerEndpoints(
      ['ws://192.168.1.9:39001/peer', 'ws://[fd12:3456:789a::3]:39001/peer'],
      { en0: [lan], utun: [v6ula] }
    );
    expect(ranked).toEqual(['ws://[fd12:3456:789a::3]:39001/peer', 'ws://192.168.1.9:39001/peer']);
  });

  test('is deterministic and preserves relative order within the same tier and family', () => {
    const urls = [
      'ws://172.16.0.2:39001/peer',
      'ws://172.16.0.1:39001/peer',
      'ws://10.0.0.2:39001/peer',
    ];
    const ifaces = { en0: [lan] };
    expect(rankPeerEndpoints(urls, ifaces)).toEqual(urls);
    expect(rankPeerEndpoints(urls, ifaces)).toEqual(rankPeerEndpoints([...urls], ifaces));
  });

  test('treats unparsable hosts as public and keeps them last among IPv4', () => {
    expect(
      rankPeerEndpoints(['ws://hub.example.com:39001/peer', 'ws://10.0.0.1:39001/peer'], {
        en0: [lan],
      })
    ).toEqual(['ws://10.0.0.1:39001/peer', 'ws://hub.example.com:39001/peer']);
  });
});

describe('unified IP classifier (per-caller semantics)', () => {
  test.each([
    ['127.0.0.1', 'lan'],
    ['127.1.2.3', 'lan'],
    ['[127.0.0.1]', 'lan'],
    ['127.0.0.1%en0', 'lan'],
    ['127.000.000.001', 'lan'],
    ['::1', 'lan'],
    ['[::1]', 'lan'],
    ['::1%lo0', 'lan'],
    ['[::1%lo0]', 'lan'],
    ['0:0:0:0:0:0:0:1', 'lan'],
    ['localhost', 'lan'],
    ['LOCALHOST', 'lan'],
    ['[localhost]', 'lan'],
    ['::ffff:127.0.0.1', 'lan'],
    ['::FFFF:127.0.0.1', 'lan'],
    ['[::ffff:127.0.0.1]', 'lan'],
    ['::ffff:127.0.0.1%en0', 'lan'],
    ['::ffff:7f00:1', 'lan'],
    ['::ffff:7f00:0001', 'lan'],
    ['10.0.0.1', 'lan'],
    ['[10.0.0.1]', 'lan'],
    ['10.255.255.254', 'lan'],
    ['172.16.0.1', 'lan'],
    ['172.31.255.1', 'lan'],
    ['192.168.1.1', 'lan'],
    ['::ffff:10.1.2.3', 'lan'],
    ['::ffff:c0a8:0101', 'lan'],
    ['::ffff:ac10:0001', 'lan'],
    ['169.254.1.1', 'lan'],
    ['fe80::1', 'lan'],
    ['fe80::1%en0', 'lan'],
    ['[fe80::1%en0]', 'lan'],
    ['fc00::1', 'lan'],
    ['fd12:3456:789a::1', 'lan'],
    [null, 'wan'],
    [undefined, 'wan'],
    ['', 'wan'],
    ['   ', 'wan'],
    ['unknown', 'wan'],
    ['example.com', 'wan'],
    ['not-an-ip', 'wan'],
    ['peer:aa', 'wan'],
    ['local', 'wan'],
    ['127.0.0.1:8080', 'wan'],
    ['localhost:8080', 'wan'],
    ['::ffff:127.999.1.1', 'wan'],
    ['172.15.0.1', 'wan'],
    ['172.32.0.1', 'wan'],
    ['11.0.0.1', 'wan'],
    ['192.169.0.1', 'wan'],
    ['100.64.0.1', 'wan'],
    ['100.64.1.2', 'wan'],
    ['100.127.255.255', 'wan'],
    ['::ffff:100.64.1.2', 'wan'],
    ['203.0.113.10', 'wan'],
    ['8.8.8.8', 'wan'],
    ['2001:db8::1', 'wan'],
    ['::ffff:203.0.113.10', 'wan'],
    ['fec0::1', 'wan'],
    ['999.999.999.999', 'wan'],
    ['01.2.3.4', 'wan'],
    ['1:2:3:4:5:6:7:8::', 'wan'],
    [':::1', 'wan'],
  ] as const)('classifyRemoteAddress(%j) → %s', (input, expected) => {
    expect(classifyRemoteAddress(input)).toBe(expected);
  });

  test.each([
    [undefined, true],
    [null, true],
    ['', true],
    ['local', true],
    ['127.0.0.1', true],
    ['127.0.0.2', true],
    ['127.1.2.3', true],
    ['[127.0.0.1]', true],
    ['127.0.0.1%en0', true],
    ['127.000.000.001', true],
    ['::1', true],
    ['[::1]', true],
    ['::1%lo0', true],
    ['[::1%lo0]', true],
    ['localhost', true],
    ['LOCALHOST', true],
    ['::ffff:127.0.0.1', true],
    ['::FFFF:127.0.0.1', true],
    ['[::ffff:127.0.0.1]', true],
    ['::ffff:127.0.0.1%en0', true],
    ['::ffff:127.1.2.3', true],
    ['   ', false],
    ['LOCAL', false],
    ['unknown', false],
    ['8.8.8.8', false],
    ['10.0.0.9', false],
    ['192.168.1.1', false],
    ['peer:aa', false],
    ['peer:127.0.0.1', false],
    ['0:0:0:0:0:0:0:1', false],
    ['::ffff:7f00:1', false],
    ['::ffff:7f00:0001', false],
    ['127.0.0.1:8080', false],
    ['localhost:8080', false],
    ['::ffff:127.999.1.1', false],
    ['100.64.1.2', false],
    ['fe80::1', false],
    ['example.com', false],
    ['not-an-ip', false],
    ['999.999.999.999', false],
  ] as const)('isLoopbackClientIp(%j) → %s', (input, expected) => {
    expect(isLoopbackClientIp(input)).toBe(expected);
  });

  test.each([
    ['::1', true],
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:127.999.1.1', true],
    ['127.000.000.001', false],
    ['0:0:0:0:0:0:0:1', false],
    ['::ffff:7f00:1', false],
    ['127.0.0.1:8080', false],
    ['10.0.0.1', false],
    ['192.168.1.1', false],
    ['localhost', false],
    ['8.8.8.8', false],
    ['', false],
    ['not-an-ip', false],
  ] as const)('isLoopbackHostLiteral(%j) → %s', (input, expected) => {
    expect(isLoopbackHostLiteral(input)).toBe(expected);
  });

  test.each([
    ['127.0.0.1', '127.0.0.1'],
    ['8.8.8.8', '8.8.8.8'],
    ['[127.0.0.1]', '127.0.0.1'],
    ['2001:db8::1', '2001:db8::1'],
    ['[2001:db8::2]', '2001:db8::2'],
    ['::1', '::1'],
    ['::1%lo0', '::1'],
    ['[::1%lo0]', '::1'],
    ['::ffff:203.0.113.5', '::ffff:203.0.113.5'],
    ['::FFFF:203.0.113.5', '::ffff:203.0.113.5'],
    ['::ffff:c0a8:0101', '::ffff:c0a8:0101'],
    ['fe80::1%en0', 'fe80::1'],
    [undefined, undefined],
    ['', undefined],
    ['not-an-ip', undefined],
    ['unknown', undefined],
    ['999.999.999.999', undefined],
    ['127.000.000.001', undefined],
    ['01.2.3.4', undefined],
    ['127.0.0.1:8080', undefined],
    ['::ffff:127.999.1.1', undefined],
    ['1:2:3:4:5:6:7:8::', undefined],
    [':::1', undefined],
    ['localhost', undefined],
    ['example.com', undefined],
  ] as const)('parseIpLiteral(%j) → %j', (input, expected) => {
    expect(parseIpLiteral(input)).toBe(expected);
  });

  test.each([
    ['192.168.1.5', true],
    ['127.0.0.1', true],
    ['::1', true],
    ['2001:db8::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:c0a8:0101', true],
    ['::ffff:999.1.1.1', true],
    ['1:2:3:4:5:6:7:8', true],
    ['localhost', false],
    ['vibeterm.example.com', false],
    ['127.000.000.001', false],
    ['127.0.0.1:8080', false],
    ['1:2:3:4:5:6:7:8::', false],
    ['', false],
    ['not-an-ip', false],
  ] as const)('isIpAddressLiteral(%j) → %s', (input, expected) => {
    expect(isIpAddressLiteral(input)).toBe(expected);
  });

  test.each([
    ['::1', true],
    ['2001:db8::1', true],
    ['fe80::1', true],
    ['::ffff:c0a8:0101', true],
    ['1:2:3:4:5:6:7:8', true],
    ['::', true],
    ['::ffff:10.1.2.3', false],
    ['1:2:3:4:5:6:7:8::', false],
    ['127.0.0.1', false],
    ['', false],
    ['gggg::1', false],
  ] as const)('isIpv6Literal(%j) → %s', (input, expected) => {
    expect(isIpv6Literal(input)).toBe(expected);
  });

  test('looksLikeIpv6 accepts dotted mapped even when octets are out of range', () => {
    expect(looksLikeIpv6('::ffff:10.1.2.3')).toBe(true);
    expect(looksLikeIpv6('::ffff:999.1.1.1')).toBe(true);
    expect(looksLikeIpv6('2001:db8::1')).toBe(true);
    expect(looksLikeIpv6('127.0.0.1')).toBe(false);
    expect(looksLikeIpv6('1:2:3:4:5:6:7:8::')).toBe(false);
  });

  test('isIpv4DottedLiteral rejects leading zeros that parseIpv4 still classifies', () => {
    expect(isIpv4DottedLiteral('127.0.0.1')).toBe(true);
    expect(isIpv4DottedLiteral('127.000.000.001')).toBe(false);
    expect(isIpv4DottedLiteral('01.2.3.4')).toBe(false);
    expect(classifyRemoteAddress('127.000.000.001')).toBe('lan');
    expect(isLoopbackClientIp('127.000.000.001')).toBe(true);
  });

  test('CGNAT is wan for classifyRemoteAddress but true for isCgnatIpv4', () => {
    expect(classifyRemoteAddress('100.64.1.2')).toBe('wan');
    expect(isCgnatIpv4('100.64.1.2')).toBe(true);
    expect(isCgnatIpv4('::ffff:100.64.1.2')).toBe(true);
    expect(isLoopbackClientIp('100.64.1.2')).toBe(false);
    expect(isLoopbackHostLiteral('100.64.1.2')).toBe(false);
  });

  test('hex mapped loopback is lan for classify but not isLoopbackClientIp', () => {
    expect(classifyRemoteAddress('::ffff:7f00:1')).toBe('lan');
    expect(isLoopbackClientIp('::ffff:7f00:1')).toBe(false);
    expect(isLoopbackHostLiteral('::ffff:7f00:1')).toBe(false);
    expect(parseIpLiteral('::ffff:7f00:1')).toBe('::ffff:7f00:1');
  });
});
