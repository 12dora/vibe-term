export type MemoizedLoader<T> = {
  load: () => Promise<T>;
  peek: () => T | undefined;
  /** 等在途 load 落定（忽略失败）后返回当前值；停机前用它避免漏停刚加载完的模块。 */
  settled: () => Promise<T | undefined>;
  reset: () => void;
};

/** 成功结果记住；失败不缓存，下次 load 会重试。并发 load 共用同一 in-flight Promise。 */
export function createMemoizedLoader<T>(importer: () => Promise<T>): MemoizedLoader<T> {
  let value: T | undefined;
  let pending: Promise<T> | undefined;
  return {
    peek: () => value,
    settled: async () => {
      if (pending) await pending.catch(() => undefined);
      return value;
    },
    reset: () => {
      value = undefined;
      pending = undefined;
    },
    load: () => {
      if (value !== undefined) return Promise.resolve(value);
      pending ??= importer().then(
        (mod) => {
          value = mod;
          return mod;
        },
        (err: unknown) => {
          pending = undefined;
          throw err;
        }
      );
      return pending;
    },
  };
}
