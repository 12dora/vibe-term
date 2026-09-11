import { setPageModulePrerequisite } from '@/use-page-module';
import { DEFAULT_LOCALE } from '@vibeterm/shared';
import i18n from 'i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import { initReactI18next } from 'react-i18next';
import { resolveInitialLanguage } from './initial-language';
import {
  createActiveCompleteWaiter,
  createLanguageActivator,
  createLocaleUnlock,
} from './locale-unlock';
import { changeLanguageAfterRest, createRestBundleCache } from './rest-bundle';
import { setI18nRestPrerequisite } from './rest-prerequisite';

// 各语言翻译按需动态加载：每个 locale 拆成独立 chunk，首屏只加载当前语言，
// 不再把全部语言静态打进入口 bundle（原先静态 import I18N_RESOURCES 把 3 种语言全打进首屏）。
// 语言包再按 core/rest 二次切分（切分依据见 packages/shared/src/i18n/core-keys.ts）：
// core 覆盖入口 chunk 用得到的全部 key，阻塞首绘；rest 只在懒路由/懒面板需要时补进来，
// 因此首屏少下约 3/4 的语言包字节。两个 JSON 都是 `bun run build:i18n` 的生成物。
type LocaleModule = { default: { translation: Record<string, unknown> } };

const coreModules = import.meta.glob<LocaleModule>(
  '../../../../packages/shared/src/i18n/locales/generated/*.core.json'
);
const restModules = import.meta.glob<LocaleModule>(
  '../../../../packages/shared/src/i18n/locales/generated/*.rest.json'
);

function loaderFor(
  modules: Record<string, () => Promise<LocaleModule>>,
  lng: string,
  part: 'core' | 'rest'
): (() => Promise<LocaleModule>) | undefined {
  const entry = Object.entries(modules).find(([p]) => p.endsWith(`/${lng}.${part}.json`));
  return entry?.[1];
}

async function translationOf(load: () => Promise<LocaleModule>): Promise<Record<string, unknown>> {
  const mod = await load();
  const content = (mod.default ?? mod) as { translation?: Record<string, unknown> };
  return content.translation ?? {};
}

// 首屏语言在 init 前定下来：i18nReady 拉的就是它的 core chunk，main.tsx await 完直接以该语言渲染，
// 登录页也不例外——不存在「先英文、进设置页才变中文」的中间态。
const initialLanguage = resolveInitialLanguage();

let restRequested = false;

// fallbackLng 会让 i18next 把 DEFAULT_LOCALE 的 core/rest 也排进加载队列，
// 而首屏根本用不到它（core 覆盖有守卫）。这里只放行「已解锁」的语言，
// fallback 推迟到真的缺 key 时才补（见 ./locale-unlock）。
const localeUnlock = createLocaleUnlock({
  initial: initialLanguage,
  fallback: DEFAULT_LOCALE,
  loadLanguage: (lng) => i18n.reloadResources(lng, 'translation'),
  loadRest: (lng) => loadRest(lng),
  isRestRequested: () => restRequested,
  whenActiveComplete: createActiveCompleteWaiter({
    isRestRequested: () => restRequested,
    loadRest: () => loadRest(currentLanguage()),
  }),
  hasMissingKeys: (keys) => keys.some((key) => !i18n.exists(key)),
});

function currentLanguage(): string {
  return i18n.resolvedLanguage ?? i18n.language ?? DEFAULT_LOCALE;
}

// 切语言 / 事后兜底的统一入口：解锁 + 强制重载（见 createLanguageActivator 的注释）
const activateLanguage = createLanguageActivator({
  isUnlocked: (lng) => localeUnlock.isUnlocked(lng),
  unlock: (lng) => localeUnlock.unlock(lng),
  reload: (lng) => i18n.reloadResources(lng, 'translation'),
});

// init 是异步的（要拉取当前语言 chunk）；main.tsx 在首次渲染前 await 此 promise 以避免未翻译闪烁。
export const i18nReady = i18n
  .use(
    resourcesToBackend(async (lng: string, ns: string) => {
      if (ns !== 'translation' || !localeUnlock.isUnlocked(lng)) return {};
      const load = loaderFor(coreModules, lng, 'core');
      if (!load) return {};
      return translationOf(load);
    })
  )
  .use(initReactI18next)
  .init({
    lng: initialLanguage,
    fallbackLng: DEFAULT_LOCALE,
    // 缺 key 先记下、等当前语言的 rest 落地后复核，确实缺才去拉 fallback 语言；
    // 返回值就是 i18next 原本的兜底渲染（裸 key）。
    parseMissingKeyHandler: (key: string) => {
      localeUnlock.recordMissingKey(key);
      return key;
    },
    ns: ['translation'],
    defaultNS: 'translation',
    interpolation: {
      escapeValue: false,
    },
    returnNull: false,
    react: {
      // 改异步加载后不走 Suspense：main.tsx 渲染前已 await i18nReady；运行时切语言由 react-i18next 监听事件重渲染。
      useSuspense: false,
      // rest 语言包是 addResourceBundle 补进来的，必须让已挂载的组件跟着重渲染，
      // 否则先于 rest 到达就渲染过的懒面板会把裸 key 留在屏幕上。
      bindI18nStore: 'added',
    },
  });

const restCache = createRestBundleCache({
  loaderFor: (lng) => {
    const load = loaderFor(restModules, lng, 'rest');
    return load ? () => translationOf(load) : undefined;
  },
  apply: (lng, translation) => {
    i18n.addResourceBundle(lng, 'translation', translation, true, true);
  },
});
const loadRest = (lng: string): Promise<void> => restCache.load(lng);

/**
 * 懒路由 / 懒面板挂载前调用：确保当前语言（及 fallback 语言）的 rest 语言包已就位。
 * 失败会 reject——调用方必须据此决定「继续等/报错/重试」，不能当成已就位。
 */
export function ensureI18nRest(): Promise<void> {
  restRequested = true;
  // 只拉当前语言：fallback 语言的 rest 同样推迟到确实缺 key 时才补（见 localeUnlock）。
  return loadRest(currentLanguage());
}

setPageModulePrerequisite(ensureI18nRest);
setI18nRestPrerequisite(ensureI18nRest);

// 切语言先备好目标语言的 rest，再真正切：反过来的话 `languageChanged` 已经发出、
// 而新语言只有 core，已打开的设置页必然先闪一次 settings.* 裸 key。
// 调用点散在 stores / 设置页里，统一在这里包一层，避免每个调用点各自记得先 ensure。
type ChangeLanguage = typeof i18n.changeLanguage;
const changeLanguageDirect = i18n.changeLanguage.bind(i18n) as ChangeLanguage;
i18n.changeLanguage = ((lng, ...rest) => {
  if (typeof lng !== 'string') {
    return changeLanguageDirect(lng, ...rest);
  }
  // 先解锁并把资源真的取回来再切：只解锁不重载的话 backend 早先回的空包还记在
  // backendConnector 里，切过去整页都是裸 key。
  const change = () => activateLanguage(lng).then(() => changeLanguageDirect(lng, ...rest));
  if (!restRequested) {
    return change();
  }
  return changeLanguageAfterRest(lng, loadRest, change);
}) as ChangeLanguage;

// <html lang> 跟随当前语言（index.html 静态写死 en；只影响无障碍与浏览器翻译提示）
i18n.on('languageChanged', (lng: string) => {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lng.replace('_', '-');
  }
  // 绕过上面那层包装的切换（i18next 内部改语言）兜底：解锁 + 重载 + rest 该补还是要补。
  void activateLanguage(lng);
  if (restRequested) void loadRest(lng).catch(() => undefined);
});

export default i18n;
