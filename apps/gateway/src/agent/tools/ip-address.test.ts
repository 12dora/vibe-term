import { describe, expect, test } from 'bun:test';
import { isPrivateIpv6Bytes, isPrivateIpv6Hostname, parseIpv6ToBytes } from './ip-address';

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function requireBytes(text: string): Uint8Array {
  const bytes = parseIpv6ToBytes(text);
  expect(bytes).not.toBeNull();
  if (!bytes) {
    throw new Error(`expected IPv6 bytes for ${text}`);
  }
  return bytes;
}

describe('parseIpv6ToBytes', () => {
  test('解析 ::1 与 [::1]', () => {
    const loopback = new Uint8Array(16);
    loopback[15] = 1;
    expect(parseIpv6ToBytes('::1')).toEqual(loopback);
    expect(parseIpv6ToBytes('[::1]')).toEqual(loopback);
  });

  test('解析 hex 形式 IPv4-mapped loopback ::ffff:7f00:1', () => {
    const bytes = requireBytes('::ffff:7f00:1');
    expect(bytes[12]).toBe(127);
    expect(bytes[13]).toBe(0);
    expect(bytes[14]).toBe(0);
    expect(bytes[15]).toBe(1);
    expect(bytesToHex(bytes.subarray(0, 12))).toBe('00000000000000000000ffff');
  });

  test('解析嵌入点分 IPv4 的 mapped 10.x', () => {
    const dotted = requireBytes('::ffff:10.0.0.1');
    const hex = requireBytes('::ffff:0a00:1');
    expect(dotted).toEqual(hex);
    expect(dotted[12]).toBe(10);
    expect(dotted[15]).toBe(1);
  });

  test('剥 zone id 与方括号', () => {
    const a = requireBytes('fe80::1%lo0');
    const b = requireBytes('[fe80::1]');
    expect(a).toEqual(b);
    expect(a[0]).toBe(0xfe);
    expect(a[1]).toBe(0x80);
    expect(a[15]).toBe(1);
  });

  test('拒绝非法压缩', () => {
    expect(parseIpv6ToBytes('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIpv6ToBytes('1::2::3')).toBeNull();
  });
});

describe('isPrivateIpv6Hostname', () => {
  test('hex 形式 mapped loopback 视为私有', () => {
    expect(isPrivateIpv6Hostname('::ffff:7f00:1')).toBe(true);
    expect(isPrivateIpv6Hostname('[::ffff:7f00:1]')).toBe(true);
  });

  test('mapped 10.x 视为私有', () => {
    expect(isPrivateIpv6Hostname('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIpv6Hostname('::ffff:0a00:1')).toBe(true);
  });

  test('::1 与 [::1] 视为私有', () => {
    expect(isPrivateIpv6Hostname('::1')).toBe(true);
    expect(isPrivateIpv6Hostname('[::1]')).toBe(true);
  });

  test('link-local fe80::/10 视为私有', () => {
    expect(isPrivateIpv6Hostname('fe80::1')).toBe(true);
    expect(isPrivateIpv6Hostname('fe80::1%eth0')).toBe(true);
  });

  test('公网 v6 放行', () => {
    expect(isPrivateIpv6Hostname('2606:4700::1111')).toBe(false);
    expect(isPrivateIpv6Hostname('::ffff:8.8.8.8')).toBe(false);
  });

  test('按 16 字节分类 IPv4-mapped', () => {
    const loopback = requireBytes('::ffff:7f00:1');
    const publicMapped = requireBytes('::ffff:8.8.8.8');
    expect(isPrivateIpv6Bytes(loopback)).toBe(true);
    expect(isPrivateIpv6Bytes(publicMapped)).toBe(false);
  });
});
