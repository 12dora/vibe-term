import { setPageModulePrerequisite } from '@/use-page-module';
import { DEFAULT_LOCALE, type LocaleCode } from '@tmex/shared';
import i18n from 'i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import { initReactI18next } from 'react-i18next';

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

// Detect browser language
function detectBrowserLocale(): LocaleCode {
  const browserLang = navigator.language;
  if (browserLang.startsWith('zh')) return 'zh_CN';
  if (browserLang.startsWith('ja')) return 'ja_JP';
  return DEFAULT_LOCALE;
}

// init 是异步的（要拉取当前语言 chunk）；main.tsx 在首次渲染前 await 此 promise 以避免未翻译闪烁。
export const i18nReady = i18n
  .use(
    resourcesToBackend(async (lng: string, ns: string) => {
      const load = loaderFor(coreModules, lng, 'core');
      if (!load || ns !== 'translation') return {};
      return translationOf(load);
    })
  )
  .use(initReactI18next)
  .init({
    lng: detectBrowserLocale(),
    fallbackLng: DEFAULT_LOCALE,
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

const restLoads = new Map<string, Promise<void>>();
let restRequested = false;

function loadRest(lng: string): Promise<void> {
  const cached = restLoads.get(lng);
  if (cached) return cached;

  const load = loaderFor(restModules, lng, 'rest');
  const task = load
    ? translationOf(load).then(
        (translation) => {
          i18n.addResourceBundle(lng, 'translation', translation, true, true);
        },
        () => {
          // 弱网下 rest chunk 拉不到就保持 core：允许重试，不要把失败缓存成永久状态。
          restLoads.delete(lng);
        }
      )
    : Promise.resolve();

  restLoads.set(lng, task);
  return task;
}

/** 懒路由 / 懒面板挂载前调用：确保当前语言（及 fallback 语言）的 rest 语言包已就位。 */
export function ensureI18nRest(): Promise<void> {
  restRequested = true;
  const current = i18n.resolvedLanguage ?? i18n.language ?? DEFAULT_LOCALE;
  const targets = current === DEFAULT_LOCALE ? [current] : [current, DEFAULT_LOCALE];
  return Promise.all(targets.map(loadRest)).then(() => undefined);
}

setPageModulePrerequisite(ensureI18nRest);

// <html lang> 跟随当前语言（index.html 静态写死 en；只影响无障碍与浏览器翻译提示）
i18n.on('languageChanged', (lng: string) => {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lng.replace('_', '-');
  }
  // 切语言后新语言只有 core，rest 要跟着补，否则已打开的设置页会退回裸 key。
  if (restRequested) void loadRest(lng);
});

export default i18n;
