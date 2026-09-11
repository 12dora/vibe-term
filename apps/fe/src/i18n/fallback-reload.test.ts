// 真 i18next 实例上的回归：fallback 语言被锁期间 backend 回的是空包，
// backendConnector 会把 `<lng>|translation` 记成「已加载」——此后 loadLanguages 直接短路，
// 解锁了也永远拿不回语言包（缺 key 一直裸着，运行时切过去整页也是裸的）。
// 所以解锁必须走 reloadResources（见 createLanguageActivator）。
//
// 这里照 ./index.ts 的接线搭一个最小实例：同样的 backend 形状、同样的 fallbackLng、
// 同样用 createLanguageActivator 解锁。

import { describe, expect, test } from 'bun:test';
import i18next, { type i18n as I18nInstance } from 'i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import { createLanguageActivator, createLocaleUnlock } from './locale-unlock';

const RESOURCES: Record<string, Record<string, string>> = {
  zh_CN: { 'common.ok': '确定' },
  en_US: { 'common.ok': 'OK', 'only.en': 'English only' },
};

interface Harness {
  i18n: I18nInstance;
  /** backend 被真正问到的 (lng, ns)，含锁着时那次返回空包的调用 */
  reads: string[];
  activate: (lng: string) => Promise<void>;
  isUnlocked: (lng: string) => boolean;
}

async function createHarness(): Promise<Harness> {
  const reads: string[] = [];
  const i18n = i18next.createInstance();
  const unlock = createLocaleUnlock({
    initial: 'zh_CN',
    fallback: 'en_US',
    loadLanguage: (lng) => i18n.reloadResources(lng, 'translation'),
    loadRest: () => Promise.resolve(),
    isRestRequested: () => false,
    whenActiveComplete: () => Promise.resolve(),
    hasMissingKeys: () => true,
  });

  await i18n
    .use(
      resourcesToBackend(async (lng: string, ns: string) => {
        reads.push(`${lng}|${ns}`);
        if (ns !== 'translation' || !unlock.isUnlocked(lng)) return {};
        return RESOURCES[lng] ?? {};
      })
    )
    .init({
      lng: 'zh_CN',
      fallbackLng: 'en_US',
      ns: ['translation'],
      defaultNS: 'translation',
      returnNull: false,
      keySeparator: false,
      nsSeparator: false,
      interpolation: { escapeValue: false },
    });

  return {
    i18n,
    reads,
    activate: createLanguageActivator({
      isUnlocked: (lng) => unlock.isUnlocked(lng),
      unlock: (lng) => unlock.unlock(lng),
      reload: (lng) => i18n.reloadResources(lng, 'translation'),
    }),
    isUnlocked: (lng) => unlock.isUnlocked(lng),
  };
}

describe('fallback 语言的解锁与重载', () => {
  test('init 只装当前语言：fallback 被问到但拿到空包，它独有的 key 仍是裸的', async () => {
    const h = await createHarness();
    expect(h.i18n.t('common.ok')).toBe('确定');
    // fallbackLng 让 i18next 去问了 en_US，但闸门让 backend 回了空包：
    // 注意 bundle 本身是「存在但为空」——backendConnector 已经把它记成已加载了，
    // 这正是后面必须 reloadResources 而不是 loadLanguages 的原因。
    expect(h.reads).toContain('en_US|translation');
    expect(h.i18n.getResourceBundle('en_US', 'translation')).toEqual({});
    expect(h.i18n.t('only.en')).toBe('only.en');
  });

  test('解锁后必须真的重新取回来：backend 被二次问到，裸 key 变成译文', async () => {
    const h = await createHarness();
    const readsBefore = h.reads.length;

    await h.activate('en_US');

    expect(h.reads.slice(readsBefore)).toContain('en_US|translation');
    expect(h.i18n.getResourceBundle('en_US', 'translation')).toEqual(RESOURCES.en_US);
    expect(h.i18n.t('only.en')).toBe('English only');
    // 当前语言有的 key 仍然走当前语言，不该被 fallback 顶掉
    expect(h.i18n.t('common.ok')).toBe('确定');
  });

  test('只解锁不重载（旧写法 loadLanguages）补不回来——这就是本用例守的回归', async () => {
    const h = await createHarness();
    // 模拟旧实现：解锁之后只 loadLanguages，backendConnector 认为已加载，直接短路
    const unlockedOnly = createLanguageActivator({
      isUnlocked: () => false,
      unlock: () => {},
      reload: (lng) => h.i18n.loadLanguages(lng),
    });
    const readsBefore = h.reads.length;
    await unlockedOnly('en_US');
    // en_US 那一条被 backendConnector 短路掉了（只剩语言主码 `en` 的探测）
    expect(h.reads.slice(readsBefore)).not.toContain('en_US|translation');
    expect(h.i18n.getResourceBundle('en_US', 'translation')).toEqual({});
    expect(h.i18n.t('only.en')).toBe('only.en');
  });

  test('运行时切到这门被锁过的语言：解锁重载之后整页不是裸 key', async () => {
    const h = await createHarness();
    await h.activate('en_US');
    await h.i18n.changeLanguage('en_US');
    expect(h.i18n.resolvedLanguage).toBe('en_US');
    expect(h.i18n.t('common.ok')).toBe('OK');
    expect(h.i18n.t('only.en')).toBe('English only');
  });

  test('activate 幂等：已解锁的语言不再重复问 backend', async () => {
    const h = await createHarness();
    await h.activate('en_US');
    const readsBefore = h.reads.length;
    await h.activate('en_US');
    expect(h.reads).toHaveLength(readsBefore);
    expect(h.isUnlocked('en_US')).toBe(true);
  });
});
