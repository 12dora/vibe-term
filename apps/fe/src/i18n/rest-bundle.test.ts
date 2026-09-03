// rest 语言包加载：失败不能伪装成成功（否则页面永远留着裸 key），切语言必须先备好包再切。

import { describe, expect, test } from 'bun:test';
import {
  REST_RETRY_BACKOFF_MS,
  changeLanguageAfterRest,
  createRestBundleCache,
} from './rest-bundle';

function harness(results: (Record<string, unknown> | Error)[]) {
  const applied: { lng: string; keys: string[] }[] = [];
  const slept: number[] = [];
  let calls = 0;
  const cache = createRestBundleCache({
    loaderFor: () => () => {
      const next = results[calls] ?? new Error('用尽');
      calls += 1;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    apply: (lng, translation) => applied.push({ lng, keys: Object.keys(translation) }),
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });
  return { cache, applied, slept, attempts: () => calls };
}

describe('createRestBundleCache', () => {
  test('一次成功即写入资源包', async () => {
    const h = harness([{ settings: {} }]);
    await h.cache.load('zh_CN');
    expect(h.applied).toEqual([{ lng: 'zh_CN', keys: ['settings'] }]);
    expect(h.attempts()).toBe(1);
  });

  test('失败按退避重试，重试内成功仍算就位', async () => {
    const h = harness([new Error('offline'), { settings: {} }]);
    await h.cache.load('zh_CN');
    expect(h.attempts()).toBe(2);
    expect(h.slept).toEqual([REST_RETRY_BACKOFF_MS[0] as number]);
    expect(h.applied.length).toBe(1);
  });

  test('重试用尽后 reject（不能伪装成已就位），且失败不缓存成永久状态', async () => {
    const h = harness([new Error('a'), new Error('b'), new Error('c')]);
    await expect(h.cache.load('zh_CN')).rejects.toThrow('c');
    expect(h.attempts()).toBe(REST_RETRY_BACKOFF_MS.length + 1);
    expect(h.slept).toEqual([...REST_RETRY_BACKOFF_MS]);

    // 缓存里不该留下那个失败的 promise：下次还要真的重来
    const before = h.attempts();
    await expect(h.cache.load('zh_CN')).rejects.toThrow();
    expect(h.attempts()).toBeGreaterThan(before);
  });

  test('成功后复用同一个 promise，不重复拉包', async () => {
    const h = harness([{ settings: {} }]);
    const first = h.cache.load('zh_CN');
    const second = h.cache.load('zh_CN');
    expect(second).toBe(first);
    await first;
    await h.cache.load('zh_CN');
    expect(h.attempts()).toBe(1);
  });

  test('没有该语言的 rest 包时视为无需加载', async () => {
    const cache = createRestBundleCache({
      loaderFor: () => undefined,
      apply: () => {
        throw new Error('不该写入');
      },
    });
    await cache.load('xx_YY');
  });
});

describe('changeLanguageAfterRest', () => {
  test('先备好目标语言的 rest，再真正切语言', async () => {
    const order: string[] = [];
    let release: (() => void) | null = null;
    const loadRest = (lng: string) =>
      new Promise<void>((resolve) => {
        order.push(`load:${lng}`);
        release = () => {
          order.push(`loaded:${lng}`);
          resolve();
        };
      });

    const done = changeLanguageAfterRest('ja_JP', loadRest, () => {
      order.push('change');
      return Promise.resolve('t');
    });

    await Promise.resolve();
    expect(order).toEqual(['load:ja_JP']);

    (release as unknown as () => void)();
    expect(await done).toBe('t');
    expect(order).toEqual(['load:ja_JP', 'loaded:ja_JP', 'change']);
  });

  test('rest 拉不到也要放行切换，不把语言切换卡死', async () => {
    const changed: string[] = [];
    const result = await changeLanguageAfterRest(
      'ja_JP',
      () => Promise.reject(new Error('offline')),
      () => {
        changed.push('ja_JP');
        return Promise.resolve('t');
      }
    );
    expect(result).toBe('t');
    expect(changed).toEqual(['ja_JP']);
  });
});
