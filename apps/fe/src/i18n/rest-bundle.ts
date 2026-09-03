// rest 语言包的加载策略。与 vite 专属的 `import.meta.glob` 解耦，便于单测。
//
// 两条硬要求：
// 1. 失败不能伪装成成功——懒路由 / 懒面板把它当挂载前置条件，resolve 就意味着「翻译已就位」，
//    否则页面会一直留着裸 key；所以有界重试后必须抛，且不把失败缓存成永久状态。
// 2. 切语言要「先备好目标语言的 rest，再发 languageChanged」，否则已打开的设置页
//    必然先退回 settings.* 裸 key。

export type RestTranslation = Record<string, unknown>;
export type RestLoader = () => Promise<RestTranslation>;

/** 退避时长；总尝试次数 = 本数组长度 + 1 */
export const REST_RETRY_BACKOFF_MS: readonly number[] = [200, 600];

export interface RestBundleOptions {
  /** 该语言没有 rest 包时返回 undefined（视为「无需加载」） */
  loaderFor: (lng: string) => RestLoader | undefined;
  apply: (lng: string, translation: RestTranslation) => void;
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

export interface RestBundleCache {
  load: (lng: string) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRestBundleCache({
  loaderFor,
  apply,
  backoffMs = REST_RETRY_BACKOFF_MS,
  sleep = defaultSleep,
}: RestBundleOptions): RestBundleCache {
  const inflight = new Map<string, Promise<void>>();

  async function fetchWithRetry(lng: string, loader: RestLoader): Promise<void> {
    for (let round = 0; ; round += 1) {
      try {
        apply(lng, await loader());
        return;
      } catch (error) {
        const backoff = backoffMs[round];
        if (backoff === undefined) throw error;
        await sleep(backoff);
      }
    }
  }

  return {
    load(lng) {
      const cached = inflight.get(lng);
      if (cached) return cached;

      const loader = loaderFor(lng);
      const task = loader
        ? fetchWithRetry(lng, loader).catch((error: unknown) => {
            inflight.delete(lng);
            throw error;
          })
        : Promise.resolve();
      inflight.set(lng, task);
      return task;
    },
  };
}

/**
 * 切语言：先备好目标语言的 rest，再真正切（发 `languageChanged`）。
 * rest 拉不到时仍然放行——语言包缺失不该把语言切换本身卡死。
 */
export function changeLanguageAfterRest<T>(
  lng: string,
  loadRest: (lng: string) => Promise<void>,
  change: () => Promise<T>
): Promise<T> {
  return loadRest(lng)
    .catch(() => undefined)
    .then(change);
}
