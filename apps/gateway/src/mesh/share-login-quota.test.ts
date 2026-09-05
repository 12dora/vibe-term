import { describe, expect, test } from 'bun:test';
import {
  SHARE_LOGIN_MAX_FAILURES,
  SHARE_LOGIN_WINDOW_MS,
  ShareLoginQuota,
  shareLoginShareId,
} from './share-login-quota';

describe('shareLoginShareId', () => {
  test('只认 POST /api/share-access/:id/login', () => {
    expect(shareLoginShareId('POST', '/api/share-access/sh1/login')).toBe('sh1');
    expect(shareLoginShareId('GET', '/api/share-access/sh1/login')).toBeNull();
    expect(shareLoginShareId('POST', '/api/share-access/sh1')).toBeNull();
    expect(shareLoginShareId('POST', '/api/share-access/sh1/logout')).toBeNull();
    expect(shareLoginShareId('POST', '/api/auth/login')).toBeNull();
    expect(shareLoginShareId('POST', '/api/share-access//login')).toBeNull();
  });

  test('id 会被解码，超长的当作不匹配', () => {
    expect(shareLoginShareId('POST', '/api/share-access/a%20b/login')).toBe('a b');
    expect(shareLoginShareId('POST', `/api/share-access/${'x'.repeat(200)}/login`)).toBeNull();
  });
});

describe('ShareLoginQuota', () => {
  test('按（分享，来源 IP）分桶，达到上限后返回剩余锁定时间', () => {
    let now = 1_000;
    const quota = new ShareLoginQuota(() => now);
    for (let i = 0; i < SHARE_LOGIN_MAX_FAILURES - 1; i += 1) {
      quota.recordFailure('sh1', '1.1.1.1');
      expect(quota.lockedFor('sh1', '1.1.1.1')).toBe(0);
    }
    quota.recordFailure('sh1', '1.1.1.1');
    expect(quota.lockedFor('sh1', '1.1.1.1')).toBeGreaterThan(0);
    // 同一 Hub 上的其它来源 IP 与其它分享不受牵连。
    expect(quota.lockedFor('sh1', '2.2.2.2')).toBe(0);
    expect(quota.lockedFor('sh2', '1.1.1.1')).toBe(0);

    now += SHARE_LOGIN_WINDOW_MS + 1;
    expect(quota.lockedFor('sh1', '1.1.1.1')).toBe(0);
  });

  test('登录成功清桶', () => {
    const quota = new ShareLoginQuota(() => 1_000);
    for (let i = 0; i < SHARE_LOGIN_MAX_FAILURES; i += 1) quota.recordFailure('sh1', '1.1.1.1');
    expect(quota.lockedFor('sh1', '1.1.1.1')).toBeGreaterThan(0);
    quota.reset('sh1', '1.1.1.1');
    expect(quota.lockedFor('sh1', '1.1.1.1')).toBe(0);
    expect(quota.size).toBe(0);
  });
});
