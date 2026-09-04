import { describe, expect, test } from 'bun:test';

import {
  CANONICAL_V11_MIN_PEER_VERSION,
  CANONICAL_V11_REQUIRED_ERROR_PREFIX,
  formatCanonicalV11RequiredError,
  isCanonicalV11RequiredError,
  parseCanonicalV11RequiredError,
  peerSupportsCanonicalV11,
} from './canonical-version';
import { ERROR_INVALID_FRAME, ERROR_UNSUPPORTED_PROTOCOL } from './errors';

describe('canonical v1.1 版本门槛', () => {
  // 门槛是 1.1.23 而不是 1.1.22：1.1.22 的网关只播报 canonical-state-v1，1.1.22 的浏览器
  // 又把 clientVersion 硬编码成 0.1.0，两边都不可能与 v1.1 会话互通。
  test('门槛为 1.1.23', () => {
    expect(CANONICAL_V11_MIN_PEER_VERSION).toBe('1.1.23');
  });

  test('正式版本按语义化版本比较', () => {
    expect(peerSupportsCanonicalV11('1.1.23')).toBe(true);
    expect(peerSupportsCanonicalV11('1.1.24')).toBe(true);
    expect(peerSupportsCanonicalV11('1.2.0')).toBe(true);
    expect(peerSupportsCanonicalV11('2.0.0')).toBe(true);
    expect(peerSupportsCanonicalV11('1.1.22')).toBe(false);
    expect(peerSupportsCanonicalV11('1.1.21')).toBe(false);
    expect(peerSupportsCanonicalV11('1.0.99')).toBe(false);
    expect(peerSupportsCanonicalV11('0.9.9')).toBe(false);
  });

  test('_dev 后缀按去掉后缀的数字部分判定', () => {
    expect(peerSupportsCanonicalV11('1.1.24_dev')).toBe(true);
    expect(peerSupportsCanonicalV11('1.1.23_dev')).toBe(true);
    expect(peerSupportsCanonicalV11('1.1.22_dev')).toBe(false);
    expect(peerSupportsCanonicalV11(' 1.1.23_dev ')).toBe(true);
  });

  test('拿不到或无法解析的版本一律 fail-closed', () => {
    expect(peerSupportsCanonicalV11(null)).toBe(false);
    expect(peerSupportsCanonicalV11('')).toBe(false);
    expect(peerSupportsCanonicalV11('abc')).toBe(false);
    expect(peerSupportsCanonicalV11('unknown')).toBe(false);
    expect(peerSupportsCanonicalV11('1.1')).toBe(false);
    expect(peerSupportsCanonicalV11('v1.1.23')).toBe(false);
    expect(peerSupportsCanonicalV11('1.1.23_beta')).toBe(false);
    expect(peerSupportsCanonicalV11('_dev')).toBe(false);
  });

  test('预发布版本低于同号正式版', () => {
    expect(peerSupportsCanonicalV11('1.1.23-rc.1')).toBe(false);
    expect(peerSupportsCanonicalV11('1.1.24-rc.1')).toBe(true);
  });
});

describe('canonical v1.1 门槛拒绝的 ERROR 帧识别', () => {
  test('前缀即契约，网关与客户端共用同一常量', () => {
    expect(CANONICAL_V11_REQUIRED_ERROR_PREFIX).toBe('canonical-state-v1.1 required');
  });

  test('只认 ERROR_UNSUPPORTED_PROTOCOL 且 message 以该前缀开头', () => {
    const client = `${CANONICAL_V11_REQUIRED_ERROR_PREFIX}: client 1.1.21 < 1.1.23`;
    const node = `${CANONICAL_V11_REQUIRED_ERROR_PREFIX}: node node-a version unknown < 1.1.23`;
    expect(isCanonicalV11RequiredError(ERROR_UNSUPPORTED_PROTOCOL, client)).toBe(true);
    expect(isCanonicalV11RequiredError(ERROR_UNSUPPORTED_PROTOCOL, node)).toBe(true);
    expect(isCanonicalV11RequiredError(ERROR_UNSUPPORTED_PROTOCOL, 'Unsupported protocol')).toBe(
      false
    );
    expect(isCanonicalV11RequiredError(ERROR_INVALID_FRAME, client)).toBe(false);
    expect(isCanonicalV11RequiredError(ERROR_UNSUPPORTED_PROTOCOL, `x ${client}`)).toBe(false);
  });
});

describe('canonical v1.1 拒绝 message 的拼装与解析', () => {
  test('node 形态带上节点编号与版本，client 形态只带版本', () => {
    expect(
      formatCanonicalV11RequiredError({ side: 'node', nodeId: 'node-a', version: '1.1.22' })
    ).toBe('canonical-state-v1.1 required: node node-a version 1.1.22 < 1.1.23');
    expect(formatCanonicalV11RequiredError({ side: 'client', version: '1.1.21' })).toBe(
      'canonical-state-v1.1 required: client 1.1.21 < 1.1.23'
    );
  });

  test('节点编号或版本缺失时写 unknown', () => {
    expect(formatCanonicalV11RequiredError({ side: 'node', nodeId: null, version: null })).toBe(
      'canonical-state-v1.1 required: node unknown version unknown < 1.1.23'
    );
    expect(formatCanonicalV11RequiredError({ side: 'client', version: null })).toBe(
      'canonical-state-v1.1 required: client unknown < 1.1.23'
    );
  });

  test('拼装与解析互为逆运算，两侧共用同一契约', () => {
    const cases: Array<{ side: 'client' | 'node'; nodeId: string | null; version: string | null }> =
      [
        { side: 'node', nodeId: 'a1b2c3d4e5f6', version: '1.1.22' },
        { side: 'node', nodeId: 'a1b2c3d4e5f6', version: null },
        { side: 'node', nodeId: null, version: '1.1.22_dev' },
        { side: 'client', nodeId: null, version: '0.1.0' },
        { side: 'client', nodeId: null, version: null },
      ];
    for (const info of cases) {
      expect(
        parseCanonicalV11RequiredError(
          ERROR_UNSUPPORTED_PROTOCOL,
          formatCanonicalV11RequiredError(info)
        )
      ).toEqual(info);
    }
  });

  test('非该类错误或格式不符时返回 null', () => {
    const client = formatCanonicalV11RequiredError({ side: 'client', version: '1.1.21' });
    expect(parseCanonicalV11RequiredError(ERROR_INVALID_FRAME, client)).toBeNull();
    expect(
      parseCanonicalV11RequiredError(ERROR_UNSUPPORTED_PROTOCOL, 'Unsupported protocol')
    ).toBeNull();
    expect(
      parseCanonicalV11RequiredError(
        ERROR_UNSUPPORTED_PROTOCOL,
        `${CANONICAL_V11_REQUIRED_ERROR_PREFIX}: gateway 1.1.21 < 1.1.23`
      )
    ).toBeNull();
    expect(
      parseCanonicalV11RequiredError(
        ERROR_UNSUPPORTED_PROTOCOL,
        `${CANONICAL_V11_REQUIRED_ERROR_PREFIX}: node node-a < 1.1.23`
      )
    ).toBeNull();
    expect(
      parseCanonicalV11RequiredError(
        ERROR_UNSUPPORTED_PROTOCOL,
        CANONICAL_V11_REQUIRED_ERROR_PREFIX
      )
    ).toBeNull();
  });
});
