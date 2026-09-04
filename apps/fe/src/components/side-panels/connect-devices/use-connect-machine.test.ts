// 指引对 `/api/local/status` 的「允许缺失」口径：401 / 404 都只是拿不到现状。

import { describe, expect, test } from 'bun:test';
import { LOCAL_STATUS_QUERY_KEY } from '@/pages/settings/status-queries';
import { LocalApiError } from '@tmex/api-client/local/local-api';
import { GUIDE_LOCAL_STATUS_QUERY_KEY, isLocalStatusMissing } from './use-connect-machine';

describe('isLocalStatusMissing', () => {
  test('未登录与旧节点没有这条路由：都按拿不到现状处理', () => {
    expect(isLocalStatusMissing(new LocalApiError('unauthorized', 'no session', 401))).toBe(true);
    expect(isLocalStatusMissing(new LocalApiError('not_found', 'no route', 404))).toBe(true);
  });

  test('别的失败仍是失败：不能一并吞掉', () => {
    expect(isLocalStatusMissing(new LocalApiError('server_error', 'boom', 500))).toBe(false);
    expect(isLocalStatusMissing(new Error('offline'))).toBe(false);
    expect(isLocalStatusMissing(null)).toBe(false);
  });
});

describe('GUIDE_LOCAL_STATUS_QUERY_KEY', () => {
  test('与设置页共用的那份缓存分开：口径不同，不能互相写', () => {
    expect(GUIDE_LOCAL_STATUS_QUERY_KEY).not.toEqual(LOCAL_STATUS_QUERY_KEY);
    expect([...GUIDE_LOCAL_STATUS_QUERY_KEY].slice(0, LOCAL_STATUS_QUERY_KEY.length)).toEqual([
      ...LOCAL_STATUS_QUERY_KEY,
    ]);
  });
});
