import { describe, expect, test } from 'bun:test';

import {
  CANONICAL_V11_MIN_PEER_VERSION,
  CANONICAL_V11_REQUIRED_ERROR_PREFIX,
  isCanonicalV11RequiredError,
  peerSupportsCanonicalV11,
} from './canonical-version';
import { ERROR_INVALID_FRAME, ERROR_UNSUPPORTED_PROTOCOL } from './errors';

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

describe('canonical v1.1 门槛拒绝的 ERROR 帧识别', () => {
  test('前缀即契约，网关与客户端共用同一常量', () => {
    expect(CANONICAL_V11_REQUIRED_ERROR_PREFIX).toBe('canonical-state-v1.1 required');
  });

  test('只认 ERROR_UNSUPPORTED_PROTOCOL 且 message 以该前缀开头', () => {
    const client = `${CANONICAL_V11_REQUIRED_ERROR_PREFIX}: client 1.1.21 < 1.1.22`;
    const node = `${CANONICAL_V11_REQUIRED_ERROR_PREFIX}: node unknown < 1.1.22`;
    expect(isCanonicalV11RequiredError(ERROR_UNSUPPORTED_PROTOCOL, client)).toBe(true);
    expect(isCanonicalV11RequiredError(ERROR_UNSUPPORTED_PROTOCOL, node)).toBe(true);
    expect(isCanonicalV11RequiredError(ERROR_UNSUPPORTED_PROTOCOL, 'Unsupported protocol')).toBe(
      false
    );
    expect(isCanonicalV11RequiredError(ERROR_INVALID_FRAME, client)).toBe(false);
    expect(isCanonicalV11RequiredError(ERROR_UNSUPPORTED_PROTOCOL, `x ${client}`)).toBe(false);
  });
});
