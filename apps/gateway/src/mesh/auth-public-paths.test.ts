import { describe, expect, test } from 'bun:test';
import { isAuthLoginPublicPath, isShareAccessPath } from './auth-public-paths';

describe('分享公开面收紧到契约里的三个端点', () => {
  test('三个端点在对应方法上公开', () => {
    expect(isShareAccessPath('/api/share-access/sh-1', 'GET')).toBe(true);
    expect(isShareAccessPath('/api/share-access/sh-1/login', 'POST')).toBe(true);
    expect(isShareAccessPath('/api/share-access/sh-1/logout', 'POST')).toBe(true);
  });

  test('方法不符不公开', () => {
    expect(isShareAccessPath('/api/share-access/sh-1', 'DELETE')).toBe(false);
    expect(isShareAccessPath('/api/share-access/sh-1/login', 'GET')).toBe(false);
  });

  test('只有路径时按形状判定', () => {
    expect(isShareAccessPath('/api/share-access/sh-1')).toBe(true);
    expect(isShareAccessPath('/api/share-access/sh-1/logout')).toBe(true);
  });

  test('同前缀的其它路径一律不公开', () => {
    expect(isShareAccessPath('/api/share-access')).toBe(false);
    expect(isShareAccessPath('/api/share-access/')).toBe(false);
    expect(isShareAccessPath('/api/share-access/sh-1/')).toBe(false);
    expect(isShareAccessPath('/api/share-access/sh-1/admin')).toBe(false);
    expect(isShareAccessPath('/api/share-access/sh-1/log/1')).toBe(false);
    expect(isShareAccessPath('/api/share')).toBe(false);
  });

  test('登录前公开面不受影响', () => {
    expect(isAuthLoginPublicPath('/api/auth/login', 'POST')).toBe(true);
    expect(isAuthLoginPublicPath('/api/auth/logout', 'POST')).toBe(false);
  });
});
