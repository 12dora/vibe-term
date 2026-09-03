import { describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import {
  LocalAuthStore,
  MemoryLocalAuthStore,
  buildLocalAuthStatus,
  decideLocalAuthBootstrap,
  decideLocalAuthToggle,
  defaultLoginEnforced,
  isLoopbackClientIp,
  validateLocalAuthPassword,
  validateLocalAuthUsername,
} from './local-auth-settings';

describe('buildLocalAuthStatus', () => {
  test('standalone 默认未生效', () => {
    expect(
      buildLocalAuthStatus({ standalone: true, enabled: false, credentialsPresent: false })
    ).toEqual({
      supported: true,
      enabled: false,
      effective: false,
      credentialsPresent: false,
    });
  });

  test('仅 enabled 无凭证仍不生效', () => {
    expect(
      buildLocalAuthStatus({ standalone: true, enabled: true, credentialsPresent: false })
    ).toEqual({
      supported: true,
      enabled: true,
      effective: false,
      credentialsPresent: false,
    });
  });

  test('standalone + enabled + 凭证 → effective', () => {
    expect(
      buildLocalAuthStatus({ standalone: true, enabled: true, credentialsPresent: true })
    ).toEqual({
      supported: true,
      enabled: true,
      effective: true,
      credentialsPresent: true,
    });
  });

  test('hub/node 不支持本机开关', () => {
    expect(
      buildLocalAuthStatus({ standalone: false, enabled: true, credentialsPresent: true })
    ).toEqual({
      supported: false,
      enabled: true,
      effective: false,
      credentialsPresent: true,
    });
  });
});

describe('decideLocalAuthToggle', () => {
  const base = {
    standalone: true,
    wantEnabled: true,
    credentialsPresent: true,
    loopback: true,
    authenticated: false,
  };

  test('无凭证拒绝开启', () => {
    expect(decideLocalAuthToggle({ ...base, credentialsPresent: false })).toEqual({
      ok: false,
      code: 'CREDENTIALS_REQUIRED',
      status: 409,
    });
  });

  test('公网未登录拒绝开关', () => {
    expect(decideLocalAuthToggle({ ...base, loopback: false, authenticated: false })).toEqual({
      ok: false,
      code: 'LOCAL_ONLY',
      status: 403,
    });
  });

  test('本机可开启', () => {
    expect(decideLocalAuthToggle(base)).toEqual({ ok: true, enabled: true });
  });

  test('已登录可从远端关闭', () => {
    expect(
      decideLocalAuthToggle({
        ...base,
        wantEnabled: false,
        loopback: false,
        authenticated: true,
      })
    ).toEqual({ ok: true, enabled: false });
  });

  test('非 standalone 404', () => {
    expect(decideLocalAuthToggle({ ...base, standalone: false })).toEqual({
      ok: false,
      code: 'not_standalone',
      status: 404,
    });
  });
});

describe('decideLocalAuthBootstrap', () => {
  const base = {
    standalone: true,
    enabled: false,
    credentialsPresent: false,
    loopback: true,
  };

  test('本机无凭证允许 bootstrap', () => {
    expect(decideLocalAuthBootstrap(base)).toEqual({ ok: true });
  });

  test('已有用户拒绝', () => {
    expect(decideLocalAuthBootstrap({ ...base, credentialsPresent: true })).toEqual({
      ok: false,
      code: 'CREDENTIALS_EXIST',
      status: 409,
    });
  });

  test('开关已开拒绝', () => {
    expect(decideLocalAuthBootstrap({ ...base, enabled: true })).toEqual({
      ok: false,
      code: 'LOCAL_AUTH_ENABLED',
      status: 409,
    });
  });

  test('公网拒绝', () => {
    expect(decideLocalAuthBootstrap({ ...base, loopback: false })).toEqual({
      ok: false,
      code: 'LOCAL_ONLY',
      status: 403,
    });
  });
});

describe('isLoopbackClientIp', () => {
  test('缺失 / local / 127/::1 为本机', () => {
    expect(isLoopbackClientIp(undefined)).toBe(true);
    expect(isLoopbackClientIp(null)).toBe(true);
    expect(isLoopbackClientIp('local')).toBe(true);
    expect(isLoopbackClientIp('127.0.0.1')).toBe(true);
    expect(isLoopbackClientIp('127.0.0.2')).toBe(true);
    expect(isLoopbackClientIp('::1')).toBe(true);
    expect(isLoopbackClientIp('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackClientIp('localhost')).toBe(true);
    expect(isLoopbackClientIp('[::1]')).toBe(true);
    expect(isLoopbackClientIp('::1%lo0')).toBe(true);
    expect(isLoopbackClientIp('127.000.000.001')).toBe(true);
    expect(isLoopbackClientIp('::ffff:127.0.0.1%en0')).toBe(true);
  });

  test('公网与 peer 不是本机', () => {
    expect(isLoopbackClientIp('8.8.8.8')).toBe(false);
    expect(isLoopbackClientIp('10.0.0.9')).toBe(false);
    expect(isLoopbackClientIp('peer:aa')).toBe(false);
    expect(isLoopbackClientIp('::ffff:7f00:1')).toBe(false);
    expect(isLoopbackClientIp('0:0:0:0:0:0:0:1')).toBe(false);
    expect(isLoopbackClientIp('127.0.0.1:8080')).toBe(false);
    expect(isLoopbackClientIp('LOCAL')).toBe(false);
  });
});

describe('validateLocalAuthUsername / password', () => {
  test('用户名与口令规则与 hub setup 对齐', () => {
    expect(validateLocalAuthUsername('alice')).toEqual({ ok: true });
    expect(validateLocalAuthUsername('bad name').ok).toBe(false);
    expect(validateLocalAuthPassword('tmex-test')).toEqual({ ok: true });
    expect(validateLocalAuthPassword('short').ok).toBe(false);
  });
});

describe('defaultLoginEnforced', () => {
  test('hub/node 恒 true；standalone 跟随 live effective', () => {
    expect(defaultLoginEnforced({ hub: true, node: true, relay: false }, () => false)).toBe(true);
    expect(defaultLoginEnforced({ hub: false, node: true, relay: false }, () => false)).toBe(true);
    expect(defaultLoginEnforced({ hub: false, node: false, relay: false }, () => false)).toBe(false);
    expect(defaultLoginEnforced({ hub: false, node: false, relay: false }, () => true)).toBe(true);
  });
});

describe('LocalAuthStore', () => {
  test('migration 建表且默认 false，round-trip enabled', () => {
    const { sqlite, db, close } = createMigratedAuthDb();
    try {
      const tables = sqlite
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_auth_settings'"
        )
        .all() as Array<{ name: string }>;
      expect(tables).toEqual([{ name: 'local_auth_settings' }]);
      const store = new LocalAuthStore(db);
      expect(store.getEnabled()).toBe(false);
      store.setEnabled(true);
      expect(store.getEnabled()).toBe(true);
      store.setEnabled(false);
      expect(store.getEnabled()).toBe(false);
    } finally {
      close();
    }
  });

  test('MemoryLocalAuthStore 独立于 DB', () => {
    const mem = new MemoryLocalAuthStore();
    expect(mem.getEnabled()).toBe(false);
    mem.setEnabled(true);
    expect(mem.getEnabled()).toBe(true);
  });
});
