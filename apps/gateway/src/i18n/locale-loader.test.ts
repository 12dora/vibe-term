import { describe, expect, test } from 'bun:test';
import { type ServerLocaleLoaderDeps, createServerLocaleLoader } from './locale-loader';

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
