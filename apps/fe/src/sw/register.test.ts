// 注册策略：生产注册、非生产注销、无 SW 支持时静默、异常不外泄。

import { describe, expect, test } from 'bun:test';
import {
  SERVICE_WORKER_URL,
  type ServiceWorkerContainerLike,
  applyServiceWorkerPolicy,
  shouldRegisterServiceWorker,
} from './register';
import type { SwUpdateRegistrationLike } from './sw-update';

/** 注册成功后交给换代接管的那个对象；这里只要求能被原样带回来 */
const REGISTRATION: SwUpdateRegistrationLike = {
  waiting: null,
  installing: null,
  update: async () => undefined,
  addEventListener: () => undefined,
};

function container(overrides: Partial<ServiceWorkerContainerLike> = {}) {
  const registered: { url: string; scope?: string }[] = [];
  const unregistered: string[] = [];
  const base: ServiceWorkerContainerLike = {
    register: async (url, options) => {
      registered.push({ url, scope: options?.scope });
      return REGISTRATION;
    },
    getRegistrations: async () =>
      ['a', 'b'].map((id) => ({
        unregister: async () => {
          unregistered.push(id);
          return true;
        },
      })),
    ...overrides,
  };
  return { base, registered, unregistered };
}

describe('shouldRegisterServiceWorker', () => {
  test('分享页不装应用壳缓存', () => {
    expect(shouldRegisterServiceWorker('/s/AbCd1234')).toBe(false);
    expect(shouldRegisterServiceWorker('/n/aabbccddeeff00112233445566778899/s/AbCd1234')).toBe(
      false
    );
  });

  test('其余路由照常注册', () => {
    for (const path of ['/', '/devices', '/login', '/settings/nodes', '/n/abc/devices']) {
      expect(shouldRegisterServiceWorker(path)).toBe(true);
    }
  });
});

describe('applyServiceWorkerPolicy', () => {
  test('生产注册根作用域的 /sw.js，并把 registration 交出去接线', async () => {
    const { base, registered, unregistered } = container();
    expect(await applyServiceWorkerPolicy(base, true, '/devices')).toBe(REGISTRATION);
    expect(registered).toEqual([{ url: SERVICE_WORKER_URL, scope: '/' }]);
    expect(unregistered).toEqual([]);
  });

  test('分享页不注册，也不去动已有注册', async () => {
    const { base, registered, unregistered } = container();
    expect(await applyServiceWorkerPolicy(base, true, '/s/AbCd1234')).toBeNull();
    expect(registered).toEqual([]);
    expect(unregistered).toEqual([]);
  });

  test('非生产即便在分享页也照常注销旧 SW', async () => {
    const { base, unregistered } = container();
    await applyServiceWorkerPolicy(base, false, '/s/AbCd1234');
    expect(unregistered).toEqual(['a', 'b']);
  });

  test('非生产注销全部已有注册且不再注册', async () => {
    const { base, registered, unregistered } = container();
    expect(await applyServiceWorkerPolicy(base, false)).toBeNull();
    expect(registered).toEqual([]);
    expect(unregistered).toEqual(['a', 'b']);
  });

  test('浏览器不支持 serviceWorker 时静默返回', async () => {
    expect(await applyServiceWorkerPolicy(undefined, true)).toBeNull();
  });

  test('注册失败不抛出，也不交出 registration', async () => {
    const { base } = container({
      register: () => Promise.reject(new Error('SecurityError')),
    });
    expect(await applyServiceWorkerPolicy(base, true)).toBeNull();
  });

  test('注销失败不抛出', async () => {
    const { base } = container({
      getRegistrations: () => Promise.reject(new Error('nope')),
    });
    await applyServiceWorkerPolicy(base, false);
  });
});
