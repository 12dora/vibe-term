// 密码登录第二步的判定：服务端策略为 `either` 时验证码单独就能过关，不该再弹通行密钥仪式；
// 旧节点不下发 `secondFactorPolicy`，必须原样保持「两者皆需」的老行为。

import { describe, expect, test } from 'bun:test';
import { shouldRunPasskeySecondFactor, totpSecondFactorHintKey } from './second-factor';

describe('shouldRunPasskeySecondFactor', () => {
  test('本 origin 没有通行密钥：无论有没有验证码都不做仪式', () => {
    expect(shouldRunPasskeySecondFactor({ passkeySecondFactor: false }, true)).toBe(false);
    expect(shouldRunPasskeySecondFactor({ passkeySecondFactor: false }, false)).toBe(false);
    expect(shouldRunPasskeySecondFactor({}, true)).toBe(false);
    expect(
      shouldRunPasskeySecondFactor({ passkeySecondFactor: false, secondFactorPolicy: 'totp' }, true)
    ).toBe(false);
  });

  test('either + 已输验证码：不弹仪式（验证码单独满足第二步）', () => {
    expect(
      shouldRunPasskeySecondFactor(
        { passkeySecondFactor: true, secondFactorPolicy: 'either' },
        true
      )
    ).toBe(false);
  });

  test('either 但没输验证码：仍要做仪式', () => {
    expect(
      shouldRunPasskeySecondFactor(
        { passkeySecondFactor: true, secondFactorPolicy: 'either' },
        false
      )
    ).toBe(true);
  });

  test('policy=passkey（这里只有通行密钥）：行为不变', () => {
    expect(
      shouldRunPasskeySecondFactor(
        { passkeySecondFactor: true, secondFactorPolicy: 'passkey' },
        true
      )
    ).toBe(true);
    expect(
      shouldRunPasskeySecondFactor(
        { passkeySecondFactor: true, secondFactorPolicy: 'passkey' },
        false
      )
    ).toBe(true);
  });

  test('旧节点不下发 secondFactorPolicy：按老的「两者皆需」做仪式', () => {
    expect(shouldRunPasskeySecondFactor({ passkeySecondFactor: true }, true)).toBe(true);
    expect(shouldRunPasskeySecondFactor({ passkeySecondFactor: true }, false)).toBe(true);
  });
});

describe('totpSecondFactorHintKey', () => {
  test('两种因子都配齐才给说明', () => {
    expect(
      totpSecondFactorHintKey({ passkeySecondFactor: true, secondFactorPolicy: 'either' })
    ).toBe('auth.login.totpInsteadOfPasskey');
  });

  test('只有 TOTP / 只有通行密钥 / 旧节点：都不给说明', () => {
    expect(
      totpSecondFactorHintKey({ passkeySecondFactor: false, secondFactorPolicy: 'totp' })
    ).toBeNull();
    expect(
      totpSecondFactorHintKey({ passkeySecondFactor: true, secondFactorPolicy: 'passkey' })
    ).toBeNull();
    expect(totpSecondFactorHintKey({ passkeySecondFactor: true })).toBeNull();
    expect(totpSecondFactorHintKey({})).toBeNull();
  });
});
