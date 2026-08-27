import { describe, expect, test } from 'bun:test';
import { assembleIpv6Bytes, parseIpv6ToBytes, tokenizeIpv6 } from './ip-address';
import { rewriteEmbeddedIpv4, stripIpv6Decorators } from './ipv6-parse';

function formatGroups(bytes: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16).padStart(4, '0'));
  }
  return groups.join(':');
}

const KNOWN_ADDRESSES: Array<{ input: string; groups: string }> = [
  { input: '::', groups: '0000:0000:0000:0000:0000:0000:0000:0000' },
  { input: '::1', groups: '0000:0000:0000:0000:0000:0000:0000:0001' },
  { input: '[::1]', groups: '0000:0000:0000:0000:0000:0000:0000:0001' },
  { input: '1:2:3:4:5:6:7:8', groups: '0001:0002:0003:0004:0005:0006:0007:0008' },
  { input: '2001:db8::1', groups: '2001:0db8:0000:0000:0000:0000:0000:0001' },
  { input: 'fe80::1%lo0', groups: 'fe80:0000:0000:0000:0000:0000:0000:0001' },
  { input: '[fe80::1%eth0]', groups: 'fe80:0000:0000:0000:0000:0000:0000:0001' },
  { input: '::ffff:7f00:1', groups: '0000:0000:0000:0000:0000:ffff:7f00:0001' },
  { input: '::ffff:10.0.0.1', groups: '0000:0000:0000:0000:0000:ffff:0a00:0001' },
  { input: '::ffff:8.8.8.8', groups: '0000:0000:0000:0000:0000:ffff:0808:0808' },
  { input: '2606:4700::1111', groups: '2606:4700:0000:0000:0000:0000:0000:1111' },
  { input: 'ff02::1', groups: 'ff02:0000:0000:0000:0000:0000:0000:0001' },
];

const MALFORMED = [
  '',
  'localhost',
  '1.2.3.4',
  '1:2:3',
  '1:2:3:4:5:6:7:8:9',
  '1::2::3',
  'gggg::1',
  ':::1',
  '1:2:3:4:5:6:7:8::',
  '::ffff:999.0.0.1',
  '::ffff:10.0.0',
  '::ffff:01.2.3.4',
];

describe('stripIpv6Decorators', () => {
  test('剥方括号与 zone id，并转小写', () => {
    expect(stripIpv6Decorators('[FE80::1%lo0]')).toBe('fe80::1');
    expect(stripIpv6Decorators('  ::1  ')).toBe('::1');
    expect(stripIpv6Decorators('fe80::1%eth0')).toBe('fe80::1');
  });
});

describe('rewriteEmbeddedIpv4', () => {
  test('把末尾点分 IPv4 改写成两个 hex group', () => {
    expect(rewriteEmbeddedIpv4('::ffff:10.0.0.1')).toBe('::ffff:a00:1');
    expect(rewriteEmbeddedIpv4('2001:db8::192.0.2.1')).toBe('2001:db8::c000:201');
  });

  test('无点分地址原样返回', () => {
    expect(rewriteEmbeddedIpv4('::1')).toBe('::1');
    expect(rewriteEmbeddedIpv4('fe80::1')).toBe('fe80::1');
  });

  test('非法点分 IPv4 返回 null', () => {
    expect(rewriteEmbeddedIpv4('::ffff:999.0.0.1')).toBeNull();
    expect(rewriteEmbeddedIpv4('::ffff:10.0.0')).toBeNull();
  });
});

describe('tokenizeIpv6 + assembleIpv6Bytes', () => {
  test('已知地址 tokenize 后 assemble 与 parseIpv6ToBytes 一致', () => {
    for (const { input, groups } of KNOWN_ADDRESSES) {
      const host = stripIpv6Decorators(input);
      const tokens = tokenizeIpv6(host);
      expect(tokens).not.toBeNull();
      if (!tokens) continue;
      const assembled = assembleIpv6Bytes(tokens);
      expect(assembled).not.toBeNull();
      if (!assembled) continue;
      expect(formatGroups(assembled)).toBe(groups);
      expect(parseIpv6ToBytes(input)).toEqual(assembled);
    }
  });

  test('拒绝畸形地址', () => {
    for (const input of MALFORMED) {
      const host = stripIpv6Decorators(input);
      const tokens = tokenizeIpv6(host);
      if (!tokens) {
        expect(parseIpv6ToBytes(input)).toBeNull();
        continue;
      }
      expect(assembleIpv6Bytes(tokens)).toBeNull();
      expect(parseIpv6ToBytes(input)).toBeNull();
    }
  });
});
