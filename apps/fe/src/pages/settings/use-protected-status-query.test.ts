// 受保护状态查询的纯决策部分：重试判定、状态投影、缓存动作、轮询间隔。
//
// 仓库没有 DOM 测试环境，hook 本身不可 render；这里直接测被 hook 组合的纯函数。

import { describe, expect, test } from 'bun:test';
import type { QueryKey } from '@tanstack/react-query';
import type { StatusQueryCache } from './use-protected-status-query';
import {
  projectProtectedStatus,
  protectedStatusRetry,
  refreshStatusQuery,
  writeStatusQuery,
} from './use-protected-status-query';

class FakeApiError extends Error {
  constructor(readonly status: number) {
    super(`http ${status}`);
  }
}

const isUnauthorized = (error: unknown): boolean =>
  error instanceof FakeApiError && error.status === 401;

describe('protectedStatusRetry', () => {
  test('401 不重试', () => {
    const retry = protectedStatusRetry(isUnauthorized);
    expect(retry(0, new FakeApiError(401))).toBe(false);
  });

  test('其它错误最多重试两次', () => {
    const retry = protectedStatusRetry(isUnauthorized);
    const err = new FakeApiError(500);
    expect(retry(0, err)).toBe(true);
    expect(retry(1, err)).toBe(true);
    expect(retry(2, err)).toBe(false);
  });
});

describe('projectProtectedStatus', () => {
  const base = { data: undefined, error: null, isPending: true, enabled: true, isUnauthorized };

  test('enabled 时 pending 即 loading', () => {
    const projected = projectProtectedStatus(base);
    expect(projected.loading).toBe(true);
    expect(projected.status).toBeNull();
    expect(projected.error).toBeNull();
    expect(projected.loginRequired).toBe(false);
  });

  test('关掉查询时不转圈', () => {
    expect(projectProtectedStatus({ ...base, enabled: false }).loading).toBe(false);
  });

  test('拿到数据后原样透出', () => {
    const data = { role: 'hub' };
    const projected = projectProtectedStatus({ ...base, data, isPending: false });
    expect(projected.status).toBe(data);
    expect(projected.loading).toBe(false);
  });

  test('401 只报 loginRequired，不报错', () => {
    const projected = projectProtectedStatus({
      ...base,
      isPending: false,
      error: new FakeApiError(401),
    });
    expect(projected.loginRequired).toBe(true);
    expect(projected.error).toBeNull();
  });

  test('普通错误取 message，非 Error 取字符串化结果', () => {
    expect(
      projectProtectedStatus({ ...base, isPending: false, error: new Error('boom') }).error
    ).toBe('boom');
    expect(projectProtectedStatus({ ...base, isPending: false, error: 'plain' }).error).toBe(
      'plain'
    );
  });
});

// `@tanstack/react-query` 在测试进程里被 `FilePage.test.tsx` 全局 mock 掉了，真 QueryClient
// 拿不到，这里用记录调用的替身。
function createCacheSpy(): StatusQueryCache & {
  invalidated: QueryKey[];
  written: Array<[QueryKey, unknown]>;
} {
  const invalidated: QueryKey[] = [];
  const written: Array<[QueryKey, unknown]> = [];
  return {
    invalidated,
    written,
    invalidateQueries(filters) {
      invalidated.push(filters.queryKey);
      return Promise.resolve();
    },
    setQueryData(queryKey, next) {
      written.push([queryKey, next]);
      return next;
    },
  };
}

describe('缓存动作', () => {
  test('refresh 只让自己的键失效', () => {
    const cache = createCacheSpy();
    refreshStatusQuery(cache, ['local-status']);
    expect(cache.invalidated).toEqual([['local-status']]);
    expect(cache.written).toEqual([]);
  });

  test('setStatus 直接写缓存，不触发失效', () => {
    const cache = createCacheSpy();
    const next = { mode: 'acme' };
    writeStatusQuery(cache, ['tls-status'], next);
    expect(cache.written).toEqual([[['tls-status'], next]]);
    expect(cache.invalidated).toEqual([]);
  });
});
