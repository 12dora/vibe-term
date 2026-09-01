// 设备页「在线未登录」那一档：静默登录失败后要不要补一行原因。

import { afterEach, describe, expect, test } from 'bun:test';
import { clearSessionKey } from '@/auth/session-key-store';
import { silentLoginHintKey } from './node-device-group';

afterEach(() => clearSessionKey());

describe('silentLoginHintKey', () => {
  test('还没失败 / 网络类失败：按钮已经够，不多给一行', () => {
    expect(silentLoginHintKey(null)).toBeNull();
    expect(silentLoginHintKey('NETWORK_ERROR')).toBeNull();
    expect(silentLoginHintKey('NODE_LIST_FAILED')).toBeNull();
  });

  test('凭证 / 授权类失败必须说清楚原因', () => {
    expect(silentLoginHintKey('NO_SESSION_KEY')).toBe('auth.errors.NO_SESSION_KEY');
    expect(silentLoginHintKey('TOTP_REQUIRED')).toBe('auth.errors.TOTP_REQUIRED');
    expect(silentLoginHintKey('DELEGATION_EXPIRED')).toBe('auth.errors.DELEGATION_EXPIRED');
    expect(silentLoginHintKey('NODE_PK_MISMATCH')).toBe('auth.errors.NODE_PK_MISMATCH');
  });

  test('认不出的码落到通用文案，绝不把原始码显示出来', () => {
    expect(silentLoginHintKey('SOMETHING_NEW')).toBe('auth.errors.LOGIN_FAILED');
  });

  test('没有会话时按密码路径取文案：签名类失败的现实含义就是密码不对', () => {
    expect(silentLoginHintKey('BAD_SIGNATURE')).toBe('auth.errors.wrongPassword');
  });
});
