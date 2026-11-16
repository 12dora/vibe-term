import {
  SERVER_I18N_FALLBACK,
  SERVER_I18N_FALLBACK_LOCALE,
  SERVER_I18N_LOADERS,
} from '@vibeterm/shared/i18n/server';
import i18next from 'i18next';
import { createLanguageSwitcher, createServerLocaleLoader } from './locale-loader';

// 网关只持有服务端渲染的 key（见 packages/shared/src/i18n/server-keys.ts）；
// 默认语言随模块加载，其余语言在切换到它时按需动态 import；切换一律走 syncI18nLanguage，
// 保证 await 返回时语言包已就绪，加载失败时 isI18nLanguageReady 为 false 以便下次重试。
i18next.init({
  resources: { [SERVER_I18N_FALLBACK_LOCALE]: { translation: SERVER_I18N_FALLBACK } },
  lng: SERVER_I18N_FALLBACK_LOCALE,
  fallbackLng: SERVER_I18N_FALLBACK_LOCALE,
  interpolation: {
    escapeValue: false,
  },
});

export const ensureI18nLocale = createServerLocaleLoader({
  loaders: SERVER_I18N_LOADERS,
  hasBundle: (lng) => i18next.hasResourceBundle(lng, 'translation'),
  addBundle: (lng, translation) => {
    i18next.addResourceBundle(lng, 'translation', translation, true, true);
  },
  onError: (lng, err) => console.error(`[i18n] failed to load locale ${lng}:`, err),
});

const switcher = createLanguageSwitcher({
  ensureLocale: ensureI18nLocale,
  currentLanguage: () => i18next.language,
  changeLanguage: (lng) => i18next.changeLanguage(lng),
  hasBundle: (lng) => i18next.hasResourceBundle(lng, 'translation'),
  hasLoader: (lng) => lng in SERVER_I18N_LOADERS,
});

export const syncI18nLanguage = switcher.sync;
export const isI18nLanguageReady = switcher.isReady;

export { i18next };
export const t = i18next.t.bind(i18next);
