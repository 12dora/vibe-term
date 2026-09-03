import { describe, expect, test } from 'bun:test';

import { CANONICAL_V11_MIN_PEER_VERSION, peerSupportsCanonicalV11 } from './canonical-version';

describe('canonical v1.1 版本门槛', () => {
  test('门槛为 1.1.22', () => {
    expect(CANONICAL_V11_MIN_PEER_VERSION).toBe('1.1.22');
  });

  test('正式版本按语义化版本比较', () => {
    expect(peerSupportsCanonicalV11('1.1.22')).toBe(true);
    expect(peerSupportsCanonicalV11('1.1.23')).toBe(true);
    expect(peerSupportsCanonicalV11('1.2.0')).toBe(true);
    expect(peerSupportsCanonicalV11('2.0.0')).toBe(true);
    expect(peerSupportsCanonicalV11('1.1.21')).toBe(false);
    expect(peerSupportsCanonicalV11('1.0.99')).toBe(false);
    expect(peerSupportsCanonicalV11('0.9.9')).toBe(false);
  });

  test('_dev 后缀按去掉后缀的数字部分判定', () => {
    expect(peerSupportsCanonicalV11('1.1.23_dev')).toBe(true);
    expect(peerSupportsCanonicalV11('1.1.22_dev')).toBe(true);
    expect(peerSupportsCanonicalV11('1.1.21_dev')).toBe(false);
    expect(peerSupportsCanonicalV11(' 1.1.22_dev ')).toBe(true);
  });

  test('拿不到或无法解析的版本一律 fail-closed', () => {
    expect(peerSupportsCanonicalV11(null)).toBe(false);
    expect(peerSupportsCanonicalV11('')).toBe(false);
    expect(peerSupportsCanonicalV11('abc')).toBe(false);
    expect(peerSupportsCanonicalV11('unknown')).toBe(false);
    expect(peerSupportsCanonicalV11('1.1')).toBe(false);
    expect(peerSupportsCanonicalV11('v1.1.22')).toBe(false);
    expect(peerSupportsCanonicalV11('1.1.22_beta')).toBe(false);
    expect(peerSupportsCanonicalV11('_dev')).toBe(false);
  });

  test('预发布版本低于同号正式版', () => {
    expect(peerSupportsCanonicalV11('1.1.22-rc.1')).toBe(false);
    expect(peerSupportsCanonicalV11('1.1.23-rc.1')).toBe(true);
  });
});
