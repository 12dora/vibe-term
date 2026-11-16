import {
  SERVER_I18N_FALLBACK,
  SERVER_I18N_FALLBACK_LOCALE,
  SERVER_I18N_LOADERS,
} from '@vibeterm/shared/i18n/server';
import i18next from 'i18next';
import { createServerLocaleLoader } from './locale-loader';

// 网关只持有服务端渲染的 key（见 packages/shared/src/i18n/server-keys.ts）；
// 默认语言随模块加载，其余语言在切换到它时按需动态 import。
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

i18next.on('languageChanged', (lng) => {
  void ensureI18nLocale(lng);
});

export { i18next };
export const t = i18next.t.bind(i18next);
