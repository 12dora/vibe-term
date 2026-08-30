import { describe, expect, test } from 'bun:test';
import { encodeBase64url, randomBytes } from '../auth/encoding';
import {
  KEY_LOG_PAGE_MAX_BYTES,
  UPLINK_CTL_MAX_BYTES,
  UplinkCtlError,
  assertCtlBounds,
  b64urlToBytes,
  bytesToB64url,
  decodeHubUplinkCtl,
  decodeMeshUplinkCtl,
  encodeHubUplinkCtl,
  encodeMeshUplinkCtl,
  seqFromWire,
  seqToWire,
} from './codec';

describe('uplink codec primitives', () => {
  test('seqToWire / seqFromWire 与 u64 边界', () => {
    expect(seqToWire(3n)).toBe(3);
    expect(seqFromWire(3)).toBe(3n);
    expect(seqFromWire('9')).toBe(9n);
    expect(() => seqFromWire(-1)).toThrow(UplinkCtlError);
    expect(() => seqFromWire(1.5)).toThrow(UplinkCtlError);
    expect(seqFromWire('18446744073709551615')).toBe(18446744073709551615n);
    expect(() => seqFromWire('18446744073709551616')).toThrow(UplinkCtlError);
  });

  test('b64url 往返与长度校验', () => {
    const bytes = randomBytes(32);
    expect(b64urlToBytes(bytesToB64url(bytes), 32)).toEqual(bytes);
    expect(() => b64urlToBytes('', 32)).toThrow(UplinkCtlError);
    expect(() => b64urlToBytes(encodeBase64url(randomBytes(16)), 32)).toThrow(/32 bytes/);
  });

  test('assertCtlBounds 拒绝过深 / 过长', () => {
    expect(() => assertCtlBounds('x'.repeat(4097))).toThrow(/string too long/);
    let deep: unknown = 1;
    for (let i = 0; i < 10; i++) deep = { k: deep };
    expect(() => assertCtlBounds(deep)).toThrow(/too deep/);
  });
});

describe('mesh vs hub large-page policy', () => {
  test('mesh 仅在 pending id 匹配时接受 1MiB key.log.res；hub 默认拒绝 key.log.res', () => {
    const id = 'pending-1';
    const empty = JSON.stringify({ t: 'key.log.res', records: [], id, pad: '' });
    const prefix = empty.slice(0, -2);
    const pad = 'x'.repeat(KEY_LOG_PAGE_MAX_BYTES - prefix.length - 2);
    const huge = new TextEncoder().encode(`${prefix}${pad}"}`);
    expect(huge.byteLength).toBe(KEY_LOG_PAGE_MAX_BYTES);
    expect(() => decodeMeshUplinkCtl(huge)).toThrow(/too large/);
    expect(decodeMeshUplinkCtl(huge, { pendingKeyLogId: id }).t).toBe('key.log.res');
    expect(() => decodeHubUplinkCtl(huge)).toThrow(UplinkCtlError);
    const small = JSON.stringify({ t: 'key.log.res', records: [] });
    expect(() => decodeHubUplinkCtl(small)).toThrow(UplinkCtlError);
    expect(decodeHubUplinkCtl(small, { allowKeyLogRes: true }).t).toBe('key.log.res');
  });

  test('ping round-trip 两侧一致', () => {
    expect(decodeMeshUplinkCtl(encodeMeshUplinkCtl({ t: 'ping' }))).toEqual({ t: 'ping' });
    expect(decodeHubUplinkCtl(encodeHubUplinkCtl({ t: 'ping' }))).toEqual({ t: 'ping' });
    expect(() => decodeHubUplinkCtl(new Uint8Array(UPLINK_CTL_MAX_BYTES + 1))).toThrow(
      UplinkCtlError
    );
  });
});
