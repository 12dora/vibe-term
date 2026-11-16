import { describe, expect, test } from 'bun:test';
import {
  type ServerLocaleLoaderDeps,
  createLanguageSwitcher,
  createServerLocaleLoader,
} from './locale-loader';

function harness(loaders: ServerLocaleLoaderDeps['loaders']) {
  const bundles = new Map<string, unknown>();
  const errors: string[] = [];
  const ensure = createServerLocaleLoader({
    loaders,
    hasBundle: (lng) => bundles.has(lng),
    addBundle: (lng, translation) => {
      bundles.set(lng, translation);
    },
    onError: (lng) => {
      errors.push(lng);
    },
  });
  return { ensure, bundles, errors };
}

describe('createServerLocaleLoader', () => {
  test('并发请求只加载一次，已加载后不再调用 loader', async () => {
    let calls = 0;
    const { ensure, bundles } = harness({
      zh_CN: async () => {
        calls += 1;
        return { default: { a: '甲' } };
      },
    });
    await Promise.all([ensure('zh_CN'), ensure('zh_CN')]);
    await ensure('zh_CN');
    expect(calls).toBe(1);
    expect(bundles.get('zh_CN')).toEqual({ a: '甲' });
  });

  test('无 loader 的语言直接返回', async () => {
    const { ensure, bundles, errors } = harness({});
    await ensure('fr_FR');
    expect(bundles.size).toBe(0);
    expect(errors).toEqual([]);
  });

  test('加载失败记录错误且允许重试', async () => {
    let fail = true;
    const { ensure, bundles, errors } = harness({
      ja_JP: async () => {
        if (fail) throw new Error('boom');
        return { default: { a: 'あ' } };
      },
    });
    await ensure('ja_JP');
    expect(errors).toEqual(['ja_JP']);
    expect(bundles.has('ja_JP')).toBe(false);

    fail = false;
    await ensure('ja_JP');
    expect(bundles.get('ja_JP')).toEqual({ a: 'あ' });
  });
});

function switcherHarness(loaders: ServerLocaleLoaderDeps['loaders']) {
  const { ensure, bundles } = harness(loaders);
  let language = 'en_US';
  bundles.set('en_US', {});
  const changes: string[] = [];
  const switcher = createLanguageSwitcher({
    ensureLocale: ensure,
    currentLanguage: () => language,
    changeLanguage: async (lng) => {
      changes.push(lng);
      language = lng;
    },
    hasBundle: (lng) => bundles.has(lng),
    hasLoader: (lng) => lng in loaders,
  });
  return { switcher, bundles, changes, current: () => language };
}

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createLanguageSwitcher', () => {
  test('语言包就绪后才切换语言', async () => {
    const gate = deferred();
    const { switcher, bundles, changes } = switcherHarness({
      zh_CN: async () => {
        await gate.promise;
        return { default: { a: '甲' } };
      },
    });
    const done = switcher.sync('zh_CN');
    await Promise.resolve();
    expect(changes).toEqual([]);
    gate.resolve();
    await done;
    expect(bundles.has('zh_CN')).toBe(true);
    expect(changes).toEqual(['zh_CN']);
    expect(switcher.isReady('zh_CN')).toBe(true);
  });

  test('并发切换以最后一次请求为准', async () => {
    const slow = deferred();
    const { switcher, current } = switcherHarness({
      zh_CN: async () => {
        await slow.promise;
        return { default: {} };
      },
      ja_JP: async () => ({ default: {} }),
    });
    const first = switcher.sync('zh_CN');
    await switcher.sync('ja_JP');
    slow.resolve();
    await first;
    expect(current()).toBe('ja_JP');
  });

  test('加载失败时 isReady 为 false，再次 sync 会重试', async () => {
    let fail = true;
    const { switcher, current } = switcherHarness({
      zh_CN: async () => {
        if (fail) throw new Error('boom');
        return { default: {} };
      },
    });
    await switcher.sync('zh_CN');
    expect(current()).toBe('zh_CN');
    expect(switcher.isReady('zh_CN')).toBe(false);

    fail = false;
    await switcher.sync('zh_CN');
    expect(switcher.isReady('zh_CN')).toBe(true);
  });

  test('无 loader 的语言只看当前语言', async () => {
    const { switcher } = switcherHarness({});
    expect(switcher.isReady('en_US')).toBe(true);
    await switcher.sync('fr_FR');
    expect(switcher.isReady('fr_FR')).toBe(true);
  });
});
