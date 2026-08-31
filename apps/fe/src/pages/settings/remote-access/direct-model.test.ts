// 「直接连接」路径的纯推导：保护档位、启用阶段、首位用户表单校验、错误码映射。

import { describe, expect, test } from 'bun:test';
import type { LocalAuthStatus } from '@tmex/shared';
import {
  type BootstrapDraft,
  bootstrapDraftError,
  directEnableStage,
  directProtected,
  directProtection,
  localAuthErrorKey,
} from './direct-model';

function localAuth(overrides: Partial<LocalAuthStatus> = {}): LocalAuthStatus {
  return {
    supported: true,
    enabled: false,
    effective: false,
    credentialsPresent: false,
    ...overrides,
  };
}

function draft(overrides: Partial<BootstrapDraft> = {}): BootstrapDraft {
  return { username: 'alice', password: 'correcthorse', confirm: 'correcthorse', ...overrides };
}

describe('directProtection', () => {
  test('hub / node 角色（supported=false）由节点登录保护', () => {
    expect(directProtection(localAuth({ supported: false }))).toBe('node');
    // enabled / effective 在 hub/node 上恒为 false，不能让它们盖掉 node 这一档。
    expect(directProtection(localAuth({ supported: false, effective: false }))).toBe('node');
  });

  test('standalone 已生效为 local，未生效为 unprotected', () => {
    expect(
      directProtection(localAuth({ enabled: true, effective: true, credentialsPresent: true }))
    ).toBe('local');
    expect(directProtection(localAuth())).toBe('unprotected');
    // 开关开了但没有账号：后端的 effective 才是唯一真相。
    expect(directProtection(localAuth({ enabled: true }))).toBe('unprotected');
  });

  test('后端没下发时是 unknown，绝不退化成 unprotected', () => {
    expect(directProtection(null)).toBe('unknown');
    expect(directProtection(undefined)).toBe('unknown');
  });
});

describe('directProtected', () => {
  test('只有 node / local 两档算查到了门', () => {
    expect(directProtected(localAuth({ supported: false }))).toBe(true);
    expect(directProtected(localAuth({ enabled: true, effective: true }))).toBe(true);
    expect(directProtected(localAuth())).toBe(false);
    expect(directProtected(null)).toBe(false);
  });
});

describe('directEnableStage', () => {
  test('没有任何可登录账号时先建用户，有账号只需拨开关', () => {
    expect(directEnableStage(localAuth())).toBe('bootstrap');
    expect(directEnableStage(localAuth({ credentialsPresent: true }))).toBe('enable');
    expect(directEnableStage(null)).toBe('bootstrap');
  });
});

describe('bootstrapDraftError', () => {
  test('合法草稿没有错误', () => {
    expect(bootstrapDraftError(draft())).toBeNull();
    expect(bootstrapDraftError(draft({ username: 'a.b_c-1' }))).toBeNull();
  });

  test('用户名按后端同一条正则挡住', () => {
    expect(bootstrapDraftError(draft({ username: '' }))).toBe('username');
    expect(bootstrapDraftError(draft({ username: 'has space' }))).toBe('username');
    expect(bootstrapDraftError(draft({ username: 'a/b' }))).toBe('username');
    expect(bootstrapDraftError(draft({ username: 'a'.repeat(65) }))).toBe('username');
    expect(bootstrapDraftError(draft({ username: 'a'.repeat(64) }))).toBeNull();
  });

  test('口令不足 8 位、两次不一致分别报错，且校验按顺序短路', () => {
    expect(bootstrapDraftError(draft({ password: '1234567', confirm: '1234567' }))).toBe(
      'password'
    );
    expect(bootstrapDraftError(draft({ password: '12345678', confirm: '12345678' }))).toBeNull();
    expect(bootstrapDraftError(draft({ confirm: 'other-one' }))).toBe('confirm');
    // 用户名先报：不能让下面的口令错误盖掉最上面那条。
    expect(bootstrapDraftError(draft({ username: '', password: '1' }))).toBe('username');
  });
});

describe('localAuthErrorKey', () => {
  test('已知 code 映射到各自文案', () => {
    expect(localAuthErrorKey('LOCAL_ONLY')).toBe('settings.remoteAccess.direct.errors.localOnly');
    expect(localAuthErrorKey('not_standalone')).toBe(
      'settings.remoteAccess.direct.errors.notStandalone'
    );
    expect(localAuthErrorKey('CREDENTIALS_REQUIRED')).toBe(
      'settings.remoteAccess.direct.errors.credentialsRequired'
    );
    expect(localAuthErrorKey('CREDENTIALS_EXIST')).toBe(
      'settings.remoteAccess.direct.errors.credentialsExist'
    );
    expect(localAuthErrorKey('LOCAL_AUTH_ENABLED')).toBe(
      'settings.remoteAccess.direct.errors.alreadyEnabled'
    );
    expect(localAuthErrorKey('weak_password')).toBe(
      'settings.remoteAccess.direct.errors.weakPassword'
    );
  });

  test('未知 code 落到兜底文案，不把裸 code 甩给用户', () => {
    expect(localAuthErrorKey('HTTP_500')).toBe('settings.remoteAccess.direct.errors.unknown');
    expect(localAuthErrorKey('unknown')).toBe('settings.remoteAccess.direct.errors.unknown');
  });
});
