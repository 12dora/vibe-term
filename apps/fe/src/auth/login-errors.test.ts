import { describe, expect, test } from 'bun:test';
import { loginErrorKey } from './login-errors';

describe('loginErrorKey 持有证明失败码', () => {
  test('POP_REQUIRED / POP_INVALID 两条登录路径都映射到会话失效文案', () => {
    for (const method of ['password', 'passkey'] as const) {
      expect(loginErrorKey('POP_REQUIRED', method)).toBe('auth.errors.POP_REQUIRED');
      expect(loginErrorKey('POP_INVALID', method)).toBe('auth.errors.POP_INVALID');
    }
  });
});
