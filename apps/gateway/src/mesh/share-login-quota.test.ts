import { describe, expect, test } from 'bun:test';
import {
  SHARE_LOGIN_BACKOFF_START_MS,
  SHARE_LOGIN_SHARE_MAX_FAILURES,
  SHARE_LOGIN_SHARE_SLOWDOWN_MS,
} from '../share/share-rate-limit';
import { UNKNOWN_CLIENT_KEY } from './client-ip';
import {
  SHARE_LOGIN_BACKOFF_CAP_MS,
  SHARE_LOGIN_GRACE_FAILURES,
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
  test('按（分享，来源 IP）分桶，宽限后返回剩余退避时间', () => {
    let now = 1_000;
    const quota = new ShareLoginQuota(() => now);
    for (let i = 0; i < SHARE_LOGIN_GRACE_FAILURES - 1; i += 1) {
      quota.recordFailure('sh1', '203.0.113.1');
      expect(quota.lockedFor('sh1', '203.0.113.1')).toBe(0);
    }
    quota.recordFailure('sh1', '203.0.113.1');
    expect(quota.lockedFor('sh1', '203.0.113.1')).toBe(SHARE_LOGIN_BACKOFF_START_MS);
    expect(quota.lockedFor('sh1', '203.0.113.2')).toBe(0);
    expect(quota.lockedFor('sh2', '203.0.113.1')).toBe(0);

    now += SHARE_LOGIN_BACKOFF_CAP_MS + 1;
    expect(quota.lockedFor('sh1', '203.0.113.1')).toBe(0);
  });

  test('登录成功清该 IP 失败，24 h 内仍算干净', () => {
    const quota = new ShareLoginQuota(() => 1_000);
    for (let i = 0; i < SHARE_LOGIN_GRACE_FAILURES; i += 1) {
      quota.recordFailure('sh1', '203.0.113.1');
    }
    expect(quota.lockedFor('sh1', '203.0.113.1')).toBeGreaterThan(0);
    quota.reset('sh1', '203.0.113.1');
    expect(quota.lockedFor('sh1', '203.0.113.1')).toBe(0);
  });

  test('入口预检：轮换失败不 429 干净 IP，unknown 视为脏', () => {
    const quota = new ShareLoginQuota(() => 0);
    for (let i = 0; i < SHARE_LOGIN_SHARE_MAX_FAILURES; i += 1) {
      quota.recordFailure('sh1', `198.51.100.${i}`);
    }
    expect(quota.lockedFor('sh1', '203.0.113.9')).toBe(0);
    expect(quota.lockedFor('sh1', '198.51.100.0')).toBe(SHARE_LOGIN_SHARE_SLOWDOWN_MS);
    expect(quota.lockedFor('sh1', UNKNOWN_CLIENT_KEY)).toBe(SHARE_LOGIN_SHARE_SLOWDOWN_MS);
  });
});
