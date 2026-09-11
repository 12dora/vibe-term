// 语言包的「解锁」闸门。与 vite 专属的 `import.meta.glob` 解耦，便于单测。
//
// 背景：i18next 配了 `fallbackLng`，init 时会把当前语言与 fallback 语言一起排进
// backend 的加载队列。中文用户首屏因此白下一份 en_US.core（28 KB），
// rest 阶段再白下一份 en_US.rest（119 KB）——2 Mbps 下这就是接近一秒。
//
// 做法：backend 只服务「已解锁」的语言，首屏只解锁当前语言；fallback 语言推迟到
// **确实缺 key** 时才解锁并补拉。
//
// 「确实」这两个字是关键：rest 语言包到达之前，任何一次渲染到 rest key 的 t() 都会走
// missing-key 回调，这时候去拉 fallback 等于把省下来的字节又下回去。所以缺 key 先记下，
// 等当前语言自己的 rest 落地后再复核一遍——那时还缺才是真的缺。

/** 记录的缺失 key 上限：这是兜底路径，不该因为一次渲染风暴把内存撑起来 */
const MAX_TRACKED_MISSING_KEYS = 32;

/** 等 rest 被请求的宽限期：应用壳首渲染必然早于路由 loader 调 ensureI18nRest */
export const REST_REQUEST_GRACE_MS = 5000;
const REST_REQUEST_POLL_MS = 200;

export interface ActiveCompleteOptions {
  isRestRequested: () => boolean;
  /** 当前语言的 rest 加载（已在途时返回同一个 promise） */
  loadRest: () => Promise<unknown>;
  graceMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 「当前语言该有的都有了」的信号。
 * 关键在于 rest 还没被请求时**不能**立刻判定完成：应用壳的第一次渲染早于任何路由 loader，
 * 那一瞬间满屏 rest 裸 key，直接复核必然误判成「真的缺」，于是又把 fallback 整份拉下来。
 * 这里给一个有界的宽限期等 ensureI18nRest 到来；等不到就认定本页确实只用 core。
 */
export function createActiveCompleteWaiter(options: ActiveCompleteOptions): () => Promise<void> {
  const grace = options.graceMs ?? REST_REQUEST_GRACE_MS;
  const poll = options.pollMs ?? REST_REQUEST_POLL_MS;
  const sleep = options.sleep ?? defaultSleep;

  return async () => {
    for (let waited = 0; !options.isRestRequested() && waited < grace; waited += poll) {
      await sleep(poll);
    }
    if (options.isRestRequested()) {
      await options.loadRest().catch(() => undefined);
    }
  };
}

export interface LocaleUnlockOptions {
  /** 首屏语言，立即解锁 */
  initial: string;
  /** fallback 语言（DEFAULT_LOCALE），确实缺 key 时才解锁 */
  fallback: string;
  /** 让 i18next 去拉该语言的 core（通常是 i18n.loadLanguages） */
  loadLanguage: (lng: string) => Promise<unknown>;
  /** 补该语言的 rest 包 */
  loadRest: (lng: string) => Promise<unknown>;
  /** rest 是否已经被请求过——没请求过就不必为 fallback 提前拉 rest */
  isRestRequested: () => boolean;
  /** 当前语言「该有的都有了」的信号：rest 已请求时即其加载完成，否则立即 resolve */
  whenActiveComplete: () => Promise<unknown>;
  /** 这些 key 在当前已加载的资源里是否仍然缺失 */
  hasMissingKeys: (keys: readonly string[]) => boolean;
}

export interface LocaleUnlock {
  isUnlocked(lng: string): boolean;
  /** 切语言前调用：不解锁的话 backend 会对新语言返回空包 */
  unlock(lng: string): void;
  /**
   * 渲染路径上的缺 key 回调。同步返回（不能 await），复核与补拉都在后台做，
   * 资源到位后靠 i18next 的 `added` 事件重渲染。
   */
  recordMissingKey(key: string): void;
  /** 立即解锁并补拉 fallback 语言；只会真正执行一次 */
  requestFallback(): void;
}

export function createLocaleUnlock(options: LocaleUnlockOptions): LocaleUnlock {
  const unlocked = new Set<string>([options.initial]);
  const missingKeys = new Set<string>();
  let fallbackRequested = false;
  let reviewScheduled = false;

  const requestFallback = (): void => {
    if (fallbackRequested || unlocked.has(options.fallback)) return;
    fallbackRequested = true;
    unlocked.add(options.fallback);
    void options
      .loadLanguage(options.fallback)
      .then(() => (options.isRestRequested() ? options.loadRest(options.fallback) : undefined))
      .catch(() => undefined);
  };

  const scheduleReview = (): void => {
    if (reviewScheduled) return;
    reviewScheduled = true;
    void options
      .whenActiveComplete()
      .catch(() => undefined)
      .then(() => {
        reviewScheduled = false;
        const keys = [...missingKeys];
        missingKeys.clear();
        if (keys.length > 0 && options.hasMissingKeys(keys)) requestFallback();
      });
  };

  return {
    isUnlocked: (lng) => unlocked.has(lng),
    unlock: (lng) => {
      unlocked.add(lng);
    },
    recordMissingKey: (key) => {
      if (fallbackRequested || unlocked.has(options.fallback)) return;
      if (missingKeys.size < MAX_TRACKED_MISSING_KEYS) missingKeys.add(key);
      scheduleReview();
    },
    requestFallback,
  };
}
