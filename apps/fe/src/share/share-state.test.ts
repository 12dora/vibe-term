import { describe, expect, test } from 'bun:test';
import type { ShareAccessInfo } from './access-client';
import {
  INITIAL_SHARE_VIEW_STATE,
  type ShareViewState,
  shareLockSeconds,
  shareViewReducer,
} from './share-state';

function info(patch: Partial<ShareAccessInfo> = {}): ShareAccessInfo {
  return {
    id: 'abc',
    name: 'demo',
    state: 'active',
    expiresAt: null,
    authenticated: false,
    ...patch,
  };
}

function reduce(state: ShareViewState, ...actions: Parameters<typeof shareViewReducer>[1][]) {
  return actions.reduce(shareViewReducer, state);
}

describe('shareViewReducer', () => {
  test('未认证的 active 分享 → 密码表单，并带上名称', () => {
    const next = shareViewReducer(INITIAL_SHARE_VIEW_STATE, { type: 'access', info: info() });
    expect(next.status).toBe('password');
    expect(next.name).toBe('demo');
  });

  test('已认证且带作用域 → 终端', () => {
    const next = shareViewReducer(INITIAL_SHARE_VIEW_STATE, {
      type: 'access',
      info: info({ authenticated: true, deviceId: 'd1', windowId: '@3', expiresAt: 42 }),
    });
    expect(next).toMatchObject({
      status: 'terminal',
      deviceId: 'd1',
      windowId: '@3',
      expiresAt: 42,
    });
  });

  test('已认证但缺作用域仍停在密码表单（服务端未放行）', () => {
    const next = shareViewReducer(INITIAL_SHARE_VIEW_STATE, {
      type: 'access',
      info: info({ authenticated: true }),
    });
    expect(next.status).toBe('password');
  });

  test('state=ended 的分享直接进结束态', () => {
    const next = shareViewReducer(INITIAL_SHARE_VIEW_STATE, {
      type: 'access',
      info: info({ state: 'ended', authenticated: true, deviceId: 'd1', windowId: '@3' }),
    });
    expect(next.status).toBe('ended');
    expect(next.endedReason).toBe('ended');
  });

  test.each([
    ['SHARE_NOT_FOUND', 'notFound'],
    ['SHARE_ENDED', 'ended'],
    ['SHARE_REQUEST_FAILED', 'unavailable'],
    ['SHARE_PASSWORD_INVALID', 'unavailable'],
  ] as const)('取分享信息失败 %s → %s', (code, reason) => {
    const next = shareViewReducer(INITIAL_SHARE_VIEW_STATE, { type: 'access-failed', code });
    expect(next.status).toBe('ended');
    expect(next.endedReason).toBe(reason);
  });

  test('提交时清掉上一次的错误', () => {
    const next = reduce(
      INITIAL_SHARE_VIEW_STATE,
      { type: 'access', info: info() },
      { type: 'login-failed', code: 'SHARE_PASSWORD_INVALID', retryAfterMs: null, now: 0 },
      { type: 'submit' }
    );
    expect(next.submitting).toBe(true);
    expect(next.error).toBeNull();
  });

  test('密码错误留在表单上并记错误码', () => {
    const next = reduce(
      INITIAL_SHARE_VIEW_STATE,
      { type: 'access', info: info() },
      { type: 'submit' },
      { type: 'login-failed', code: 'SHARE_PASSWORD_INVALID', retryAfterMs: null, now: 1000 }
    );
    expect(next).toMatchObject({
      status: 'password',
      submitting: false,
      error: 'SHARE_PASSWORD_INVALID',
      lockedUntil: null,
    });
  });

  test('限速锁定换算成解除时刻', () => {
    const next = shareViewReducer(
      { ...INITIAL_SHARE_VIEW_STATE, status: 'password', submitting: true },
      { type: 'login-failed', code: 'SHARE_LOGIN_LOCKED', retryAfterMs: 900_000, now: 1_000 }
    );
    expect(next.lockedUntil).toBe(901_000);
    expect(next.error).toBe('SHARE_LOGIN_LOCKED');
  });

  test('登录期间分享已结束 → 结束态而不是表单错误', () => {
    const next = shareViewReducer(
      { ...INITIAL_SHARE_VIEW_STATE, status: 'password' },
      { type: 'login-failed', code: 'SHARE_ENDED', retryAfterMs: null, now: 0 }
    );
    expect(next.status).toBe('ended');
    expect(next.endedReason).toBe('ended');
  });

  test('ws 4410 → 结束态', () => {
    const terminal = shareViewReducer(INITIAL_SHARE_VIEW_STATE, {
      type: 'access',
      info: info({ authenticated: true, deviceId: 'd1', windowId: '@3' }),
    });
    expect(shareViewReducer(terminal, { type: 'ended' })).toMatchObject({
      status: 'ended',
      endedReason: 'ended',
    });
  });

  test('ws 4401 → 回到密码表单并丢掉作用域', () => {
    const terminal = shareViewReducer(INITIAL_SHARE_VIEW_STATE, {
      type: 'access',
      info: info({ authenticated: true, deviceId: 'd1', windowId: '@3' }),
    });
    const next = shareViewReducer(terminal, { type: 'login-required' });
    expect(next).toMatchObject({
      status: 'password',
      deviceId: null,
      windowId: null,
      name: 'demo',
      error: null,
    });
  });
});

describe('shareLockSeconds', () => {
  test('未锁定为 0', () => {
    expect(shareLockSeconds(null, 1000)).toBe(0);
    expect(shareLockSeconds(500, 1000)).toBe(0);
  });

  test('向上取整到秒', () => {
    expect(shareLockSeconds(3_500, 1_000)).toBe(3);
    expect(shareLockSeconds(3_001, 1_000)).toBe(3);
  });
});
