// 失败原因 → 文案 key。两条硬要求：
//   * 传输层失败绝不显示「登录失败。」（现网那句误报）；
//   * 自动重试额度用完之后不许再说「稍后自动重试」——那是一句不会兑现的承诺。

import { afterEach, describe, expect, test } from 'bun:test';
import { nodeLoginFailureTextKey } from './login-failure-text';
import { clearSessionKey } from './session-key-store';

/** 传输层失败码（与 `login-failure-kind.test.ts` 的那张表同源，故意不跨测试文件 import）。 */
const UNREACHABLE = [
  'NODE_UNREACHABLE',
  'NETWORK_ERROR',
  'NODE_LIST_FAILED',
  'NO_CONNECTION',
  'RELAY_UNREACHABLE',
  'LINK_LOST',
  'TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'HTTP_502',
  'HTTP_504',
];

afterEach(() => clearSessionKey());

describe('nodeLoginFailureTextKey', () => {
  test('还没失败过：不多给一行', () => {
    expect(nodeLoginFailureTextKey(null)).toBeNull();
    expect(nodeLoginFailureTextKey(undefined, true)).toBeNull();
  });

  test('退避还排着：说会自动重试', () => {
    for (const code of UNREACHABLE) {
      expect([code, nodeLoginFailureTextKey(code, true)]).toEqual([code, 'auth.node.unreachable']);
    }
  });

  test('重试额度用完：换一句不承诺自动重试的（界面同时给出「重试连接」）', () => {
    for (const code of UNREACHABLE) {
      expect([code, nodeLoginFailureTextKey(code, false)]).toEqual([
        code,
        'auth.node.unreachableStalled',
      ]);
    }
    // 缺省即「不会自动重试」：调用方忘了传 retrying 也不会说出那句假承诺。
    expect(nodeLoginFailureTextKey('NODE_UNREACHABLE')).toBe('auth.node.unreachableStalled');
  });

  test('传输层失败在任何一档都不显示 auth.errors.LOGIN_FAILED', () => {
    for (const code of UNREACHABLE) {
      expect(nodeLoginFailureTextKey(code, true)).not.toBe('auth.errors.LOGIN_FAILED');
      expect(nodeLoginFailureTextKey(code, false)).not.toBe('auth.errors.LOGIN_FAILED');
    }
  });

  test('凭证类按现有分表取原因，与 retrying 无关', () => {
    for (const retrying of [true, false]) {
      expect(nodeLoginFailureTextKey('TOTP_REQUIRED', retrying)).toBe('auth.errors.TOTP_REQUIRED');
      expect(nodeLoginFailureTextKey('NO_SESSION_KEY', retrying)).toBe(
        'auth.errors.NO_SESSION_KEY'
      );
    }
  });

  test('认不出的码仍落通用文案，但那条路径已经与链路故障无关', () => {
    expect(nodeLoginFailureTextKey('SOMETHING_BRAND_NEW')).toBe('auth.errors.LOGIN_FAILED');
  });

  test('没有会话时按密码路径取文案：凭证类失败一律是同一句中性文案', () => {
    expect(nodeLoginFailureTextKey('BAD_SIGNATURE')).toBe('auth.errors.invalidCredentials');
  });
});
