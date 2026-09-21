// 登录失败码的分类：链路打不通 vs 会话真的不能用。现网那次「多个节点显示登录失败」
// 就是所有认不出的码（含 `NODE_UNREACHABLE`）一律落到「登录失败。」造成的。

import { afterEach, describe, expect, test } from 'bun:test';
import {
  classifyNodeLoginFailure,
  isUnreachableLoginFailure,
  nodeLoginFailureTextKey,
  offerNodeLogin,
} from './login-failure-kind';
import { clearSessionKey } from './session-key-store';

afterEach(() => clearSessionKey());

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
];

const CREDENTIAL = [
  'NO_SESSION_KEY',
  'UNAUTHORIZED',
  'NODE_LOGIN_REQUIRED',
  'LOGIN_FAILED',
  'INVALID_CREDENTIALS',
  'UNKNOWN_USER',
  'ROOT_KEY_MISMATCH',
  'TOTP_REQUIRED',
  'TOTP_INVALID',
  'TOTP_CODE_REQUIRED',
  'PASSKEY_REQUIRED',
  'PASSKEY_INVALID',
  'PASSKEY_VERIFY_FAILED',
  'PASSKEY_ABORTED',
  'PASSKEY_CREDENTIAL_UNKNOWN',
  'NO_PASSKEY_FOR_ORIGIN',
  'BAD_SIGNATURE',
  'BAD_DELEGATION',
  'DELEGATION_EXPIRED',
  'DELEGATION_BAD_SIGNATURE',
  'DELEGATION_METHOD_MISMATCH',
  'DELEGATION_ISSUED_IN_FUTURE',
  'DELEGATION_INVALID_TTL',
];

/** 服务端给过的其它结论：既不是链路问题，也不是「登一次就好」。 */
const OTHER = [
  'RATE_LIMITED',
  'UNKNOWN_NODE',
  'NODE_PK_MISMATCH',
  'PROTOCOL_MISMATCH',
  'TARGET_MISMATCH',
  'ENTRY_MISMATCH',
  'CHALLENGE_EXPIRED',
  'CHALLENGE_CONSUMED',
  'CHALLENGE_MISMATCH',
  'KEY_LOG_FORK',
  'SOMETHING_BRAND_NEW',
];

describe('classifyNodeLoginFailure', () => {
  test('传输层失败一律 unreachable', () => {
    for (const code of UNREACHABLE)
      expect([code, classifyNodeLoginFailure(code)]).toEqual([code, 'unreachable']);
  });

  test('凭证 / 会话类失败一律 credential', () => {
    for (const code of CREDENTIAL)
      expect([code, classifyNodeLoginFailure(code)]).toEqual([code, 'credential']);
  });

  test('其它结论与认不出的码落 other，绝不谎称成「连接不上」', () => {
    for (const code of OTHER)
      expect([code, classifyNodeLoginFailure(code)]).toEqual([code, 'other']);
  });

  test('没有码（还没失败过）按 other', () => {
    expect(classifyNodeLoginFailure(null)).toBe('other');
    expect(classifyNodeLoginFailure(undefined)).toBe('other');
    expect(classifyNodeLoginFailure('')).toBe('other');
  });

  test('只剩状态码的失败：5xx 是没送到，4xx 是对方答过话', () => {
    expect(classifyNodeLoginFailure('HTTP_502')).toBe('unreachable');
    expect(classifyNodeLoginFailure('HTTP_503')).toBe('unreachable');
    expect(classifyNodeLoginFailure('HTTP_504')).toBe('unreachable');
    expect(classifyNodeLoginFailure('HTTP_401')).toBe('other');
    expect(classifyNodeLoginFailure('HTTP_404')).toBe('other');
    expect(classifyNodeLoginFailure('HTTP_abc')).toBe('other');
  });
});

describe('isUnreachableLoginFailure / offerNodeLogin', () => {
  test('打不通时不引导用户去点登录', () => {
    expect(isUnreachableLoginFailure('NODE_UNREACHABLE')).toBe(true);
    expect(offerNodeLogin('NODE_UNREACHABLE')).toBe(false);
  });

  test('凭证类与其它结论都给登录入口', () => {
    expect(offerNodeLogin('NO_SESSION_KEY')).toBe(true);
    expect(offerNodeLogin('RATE_LIMITED')).toBe(true);
    expect(offerNodeLogin(null)).toBe(true);
  });
});

describe('nodeLoginFailureTextKey', () => {
  test('传输层失败绝不显示 auth.errors.LOGIN_FAILED', () => {
    for (const code of UNREACHABLE) {
      expect([code, nodeLoginFailureTextKey(code)]).toEqual([code, 'auth.node.unreachable']);
    }
  });

  test('凭证类按现有分表取原因', () => {
    expect(nodeLoginFailureTextKey('TOTP_REQUIRED')).toBe('auth.errors.TOTP_REQUIRED');
    expect(nodeLoginFailureTextKey('NO_SESSION_KEY')).toBe('auth.errors.NO_SESSION_KEY');
  });

  test('认不出的码仍落通用文案，但那条路径已经与链路故障无关', () => {
    expect(nodeLoginFailureTextKey('SOMETHING_BRAND_NEW')).toBe('auth.errors.LOGIN_FAILED');
  });
});
