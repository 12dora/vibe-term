import { describe, expect, test } from 'bun:test';
import { LOGIN_CODE_TTL_MS } from '@vibeterm/shared/auth';
import {
  LOGIN_CODE_GLOBAL_CAP,
  LOGIN_CODE_USER_PENDING_CAP,
  type LoginCodeCreateInput,
  LoginCodeStore,
} from './login-code-store';

function input(hashHex: string, uid = 'user-1'): LoginCodeCreateInput {
  return {
    hashHex,
    uid,
    method: 'root',
    credentialId: null,
    second: 'totp',
    createdVia: 'self',
  };
}

describe('LoginCodeStore', () => {
  test('create → consume 只成功一次，之后报已使用', () => {
    let now = 1_000;
    const store = new LoginCodeStore({ now: () => now });
    const created = store.create(input('aa'));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.grant.expiresAt).toBe(1_000 + LOGIN_CODE_TTL_MS);
    now += 5;
    const first = store.consume('aa');
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.grant.usedAt).toBe(1_005);
    expect(store.consume('aa')).toEqual({ ok: false, code: 'LOGIN_CODE_USED' });
    expect(store.get('aa')?.state).toBe('used');
  });

  test('未知码、过期码、作废码各自的错误码', () => {
    let now = 0;
    const store = new LoginCodeStore({ now: () => now });
    expect(store.consume('missing')).toEqual({ ok: false, code: 'LOGIN_CODE_INVALID' });
    store.create(input('exp'));
    store.create(input('rev'));
    expect(store.revoke('rev')?.state).toBe('revoked');
    expect(store.consume('rev')).toEqual({ ok: false, code: 'LOGIN_CODE_REVOKED' });
    now = LOGIN_CODE_TTL_MS;
    expect(store.consume('exp')).toEqual({ ok: false, code: 'LOGIN_CODE_EXPIRED' });
    expect(store.get('exp')?.state).toBe('expired');
  });

  test('重复哈希拒绝', () => {
    const store = new LoginCodeStore({ now: () => 0 });
    expect(store.create(input('dup')).ok).toBe(true);
    expect(store.create(input('dup'))).toEqual({ ok: false, reason: 'duplicate' });
  });

  test('revoke 幂等：已用的码保持已用', () => {
    const store = new LoginCodeStore({ now: () => 0 });
    store.create(input('a'));
    store.consume('a');
    expect(store.revoke('a')?.state).toBe('used');
    expect(store.revoke('missing')).toBeNull();
  });

  test('终态条目保留一个 TTL 后清除', () => {
    let now = 0;
    const store = new LoginCodeStore({ now: () => now });
    store.create(input('a'));
    now = LOGIN_CODE_TTL_MS * 2 - 1;
    expect(store.get('a')?.state).toBe('expired');
    now = LOGIN_CODE_TTL_MS * 2;
    expect(store.get('a')).toBeNull();
    expect(store.size).toBe(0);
  });

  test('每用户待兑换上限；已用的不占名额', () => {
    const store = new LoginCodeStore({ now: () => 0 });
    for (let i = 0; i < LOGIN_CODE_USER_PENDING_CAP; i++) {
      expect(store.create(input(`u${i}`)).ok).toBe(true);
    }
    expect(store.create(input('over'))).toEqual({ ok: false, reason: 'limit' });
    expect(store.create(input('other-user', 'user-2')).ok).toBe(true);
    store.consume('u0');
    expect(store.create(input('after-use')).ok).toBe(true);
  });

  test('全局上限', () => {
    const store = new LoginCodeStore({ now: () => 0 });
    for (let i = 0; i < LOGIN_CODE_GLOBAL_CAP; i++) {
      expect(store.create(input(`g${i}`, `user-${i}`)).ok).toBe(true);
    }
    expect(store.create(input('over', 'user-new'))).toEqual({ ok: false, reason: 'limit' });
  });

  test('revokeWhere 只动待兑换条目', () => {
    const store = new LoginCodeStore({ now: () => 0 });
    store.create(input('a'));
    store.create(input('b'));
    store.create(input('c', 'user-2'));
    store.consume('b');
    expect(store.revokeWhere((g) => g.uid === 'user-1')).toBe(1);
    expect(store.get('a')?.state).toBe('revoked');
    expect(store.get('b')?.state).toBe('used');
    expect(store.get('c')?.state).toBe('pending');
  });
});
