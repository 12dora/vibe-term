import type { TranslationTree } from '@vibeterm/shared/i18n/server';

type LocaleModule = { default: TranslationTree };

export interface ServerLocaleLoaderDeps {
  loaders: Partial<Record<string, () => Promise<LocaleModule>>>;
  hasBundle: (lng: string) => boolean;
  addBundle: (lng: string, translation: TranslationTree) => void;
  onError: (lng: string, err: unknown) => void;
}

/** 每个语言只加载一次；并发请求共享同一个 Promise，失败后允许下次重试。 */
export function createServerLocaleLoader(
  deps: ServerLocaleLoaderDeps
): (lng: string) => Promise<void> {
  const pending = new Map<string, Promise<void>>();

  return (lng) => {
    if (deps.hasBundle(lng)) return Promise.resolve();
    const load = deps.loaders[lng];
    if (!load) return Promise.resolve();
    const existing = pending.get(lng);
    if (existing) return existing;

    const task = load()
      .then((mod) => {
        deps.addBundle(lng, mod.default);
      })
      .catch((err: unknown) => {
        deps.onError(lng, err);
      })
      .finally(() => {
        pending.delete(lng);
      });
    pending.set(lng, task);
    return task;
  };
}

export interface LanguageSwitcherDeps {
  ensureLocale: (lng: string) => Promise<void>;
  currentLanguage: () => string;
  changeLanguage: (lng: string) => Promise<unknown>;
  hasBundle: (lng: string) => boolean;
  hasLoader: (lng: string) => boolean;
}

export interface LanguageSwitcher {
  /** 先等语言包就绪再切换；并发切换时只让最后一次请求生效。 */
  sync: (lng: string) => Promise<void>;
  /** 当前语言已是 lng 且其语言包已加载（无 loader 的语言只看当前语言）。 */
  isReady: (lng: string) => boolean;
}

export function createLanguageSwitcher(deps: LanguageSwitcherDeps): LanguageSwitcher {
  let requested = deps.currentLanguage();

  return {
    sync: async (lng) => {
      requested = lng;
      await deps.ensureLocale(lng);
      if (requested !== lng) return;
      if (deps.currentLanguage() !== lng) await deps.changeLanguage(lng);
    },
    isReady: (lng) =>
      deps.currentLanguage() === lng && (deps.hasBundle(lng) || !deps.hasLoader(lng)),
  };
}
