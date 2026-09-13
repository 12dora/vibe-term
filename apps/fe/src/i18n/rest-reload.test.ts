// rest 落地后 reloadResources 不能把「core 只有一角」的命名空间整棵冲掉。
// i18next backendConnector 写入时走浅合并 `{...pack, ...core}`：nodes / settings
// 这种 core 只有部分 key 的顶层命名空间会被换成那一角，rest 子树全部消失。
// 对照：relay 在 core 里没有入口，浅合并反而能保住它。
//
// 修复：backend 读回调返回 core 深合并已落地的 rest；reload 之后若 rest 已请求过再 apply 一次。

import { describe, expect, test } from 'bun:test';
import i18next, { type i18n as I18nInstance } from 'i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import { createLanguageActivator, createLocaleUnlock } from './locale-unlock';
import { type RestTranslation, createRestBundleCache, mergeTranslations } from './rest-bundle';

const CORE: RestTranslation = {
  common: { ok: 'OK' },
  nodes: { actions: { copy: 'Copy' }, time: { now: 'now' } },
  settings: { terminal: { loading: 'Loading' }, theme: 'Theme' },
};

const REST: RestTranslation = {
  nodes: {
    machine: { title: 'Machine' },
    ports: { title: 'Ports' },
    https: { title: 'HTTPS' },
    management: { title: 'Management' },
    columns: { name: 'Name' },
  },
  settings: {
    tabGroup: { nodes: 'Nodes' },
    nodes: { routeMode: { label: 'Route' } },
  },
  relay: { title: 'Relay' },
};

const REST_KEYS = [
  'nodes.machine.title',
  'nodes.ports.title',
  'nodes.https.title',
  'nodes.management.title',
  'nodes.columns.name',
  'settings.tabGroup.nodes',
  'settings.nodes.routeMode.label',
  'relay.title',
] as const;

function cloneTree(tree: RestTranslation): RestTranslation {
  return JSON.parse(JSON.stringify(tree)) as RestTranslation;
}

function existsAll(i18n: I18nInstance, lng?: string): boolean {
  const opts = lng ? { lng } : undefined;
  return REST_KEYS.every((key) => i18n.exists(key, opts));
}

interface Harness {
  i18n: I18nInstance;
  restCache: ReturnType<typeof createRestBundleCache>;
  activate: (lng: string) => Promise<void>;
  setRestRequested: () => void;
}

async function createHarness(
  options: {
    mergeRest?: boolean;
    initial?: string;
    restLoader?: () => Promise<RestTranslation>;
  } = {}
): Promise<Harness> {
  const mergeRest = options.mergeRest !== false;
  const initial = options.initial ?? 'en_US';
  let restRequested = false;
  const i18n: I18nInstance = i18next.createInstance();

  const restCache = createRestBundleCache({
    loaderFor: () => options.restLoader ?? (() => Promise.resolve(REST)),
    apply: (lng, translation) => {
      i18n.addResourceBundle(lng, 'translation', translation, true, true);
    },
  });

  const unlock = createLocaleUnlock({
    initial,
    fallback: 'en_US',
    loadLanguage: (lng) => i18n.reloadResources(lng, 'translation'),
    loadRest: (lng) => restCache.load(lng),
    isRestRequested: () => restRequested,
    whenActiveComplete: () => Promise.resolve(),
    hasMissingKeys: (keys) => keys.some((key) => !i18n.exists(key)),
  });

  await i18n
    .use(
      resourcesToBackend(async (lng: string, ns: string) => {
        if (ns !== 'translation' || !unlock.isUnlocked(lng)) return {};
        const rest = mergeRest ? restCache.loaded(lng) : undefined;
        const core = cloneTree(CORE);
        return rest ? mergeTranslations(core, rest) : core;
      })
    )
    .init({
      lng: initial,
      fallbackLng: false,
      ns: ['translation'],
      defaultNS: 'translation',
      returnNull: false,
      interpolation: { escapeValue: false },
    });

  return {
    i18n,
    restCache,
    activate: createLanguageActivator({
      isUnlocked: (lng) => unlock.isUnlocked(lng),
      unlock: (lng) => unlock.unlock(lng),
      reload: (lng) => i18n.reloadResources(lng, 'translation'),
      afterReload: (lng) => (restRequested ? restCache.reapply(lng) : Promise.resolve()),
    }),
    setRestRequested: () => {
      restRequested = true;
    },
  };
}

describe('reloadResources 浅合并冲掉 rest', () => {
  test('对照：backend 只回 core 时，部分命名空间的 rest 子树被整棵替换', async () => {
    const h = await createHarness({ mergeRest: false });
    await h.restCache.load('en_US');
    expect(h.i18n.exists('nodes.machine.title')).toBe(true);
    expect(h.i18n.exists('relay.title')).toBe(true);

    await h.i18n.reloadResources('en_US', 'translation');

    expect(h.i18n.exists('nodes.machine.title')).toBe(false);
    expect(h.i18n.exists('settings.tabGroup.nodes')).toBe(false);
    expect(h.i18n.exists('nodes.actions.copy')).toBe(true);
    expect(h.i18n.exists('relay.title')).toBe(true);
  });

  test('rest 落地后 reloadResources：部分 core 命名空间的 rest 子树仍在', async () => {
    const h = await createHarness();
    expect(h.i18n.exists('nodes.machine.title')).toBe(false);

    await h.restCache.load('en_US');
    expect(existsAll(h.i18n)).toBe(true);
    expect(h.i18n.t('nodes.actions.copy')).toBe('Copy');

    await h.i18n.reloadResources('en_US', 'translation');

    expect(existsAll(h.i18n)).toBe(true);
    expect(h.i18n.t('nodes.machine.title')).toBe('Machine');
    expect(h.i18n.t('nodes.actions.copy')).toBe('Copy');
    expect(h.i18n.t('relay.title')).toBe('Relay');
  });

  test('rest 在 core 之后落地：深合并保留双方', async () => {
    const h = await createHarness();
    expect(h.i18n.exists('nodes.actions.copy')).toBe(true);
    expect(h.i18n.exists('nodes.machine.title')).toBe(false);

    await h.restCache.load('en_US');

    expect(h.i18n.exists('nodes.actions.copy')).toBe(true);
    expect(h.i18n.exists('nodes.machine.title')).toBe(true);
  });

  test('reload 期间 rest 还在途：落地后再 reload，rest key 仍在', async () => {
    let release: ((translation: RestTranslation) => void) | undefined;
    const pending = new Promise<RestTranslation>((resolve) => {
      release = resolve;
    });
    const h = await createHarness({ restLoader: () => pending });

    const loading = h.restCache.load('en_US');
    await h.i18n.reloadResources('en_US', 'translation');
    expect(h.i18n.exists('nodes.machine.title')).toBe(false);

    release?.(REST);
    await loading;
    expect(existsAll(h.i18n)).toBe(true);

    await h.i18n.reloadResources('en_US', 'translation');
    expect(existsAll(h.i18n)).toBe(true);
  });

  test('切到未解锁语言：先 apply rest 再 activate/reload，rest 子树不被冲掉', async () => {
    const h = await createHarness({ initial: 'zh_CN' });
    h.setRestRequested();
    await h.restCache.load('en_US');
    expect(h.i18n.exists('nodes.machine.title', { lng: 'en_US' })).toBe(true);

    await h.activate('en_US');
    await h.i18n.changeLanguage('en_US');

    expect(existsAll(h.i18n)).toBe(true);
    expect(h.i18n.t('nodes.machine.title')).toBe('Machine');
    expect(h.i18n.t('settings.tabGroup.nodes')).toBe('Nodes');
  });

  test('activate 时 rest 还在途：afterReload 等到落地后 key 仍在', async () => {
    let release: ((translation: RestTranslation) => void) | undefined;
    const pending = new Promise<RestTranslation>((resolve) => {
      release = resolve;
    });
    const h = await createHarness({ initial: 'zh_CN', restLoader: () => pending });
    h.setRestRequested();

    const done = h.activate('en_US');
    await Promise.resolve();
    expect(h.i18n.exists('nodes.machine.title', { lng: 'en_US' })).toBe(false);

    release?.(REST);
    await done;
    await h.i18n.changeLanguage('en_US');

    expect(existsAll(h.i18n)).toBe(true);
  });

  test('即使 backend 只回 core，reapply 也能把被浅合并冲掉的 rest 补回来', async () => {
    const h = await createHarness({ mergeRest: false });
    await h.restCache.load('en_US');
    await h.i18n.reloadResources('en_US', 'translation');
    expect(h.i18n.exists('nodes.machine.title')).toBe(false);

    await h.restCache.reapply('en_US');
    expect(existsAll(h.i18n)).toBe(true);
  });
});
