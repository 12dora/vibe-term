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
