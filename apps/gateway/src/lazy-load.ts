export type MemoizedLoader<T> = {
  load: () => Promise<T>;
  peek: () => T | undefined;
  reset: () => void;
};

/** 成功结果记住；失败不缓存，下次 load 会重试。并发 load 共用同一 in-flight Promise。 */
export function createMemoizedLoader<T>(importer: () => Promise<T>): MemoizedLoader<T> {
  let value: T | undefined;
  let pending: Promise<T> | undefined;
  return {
    peek: () => value,
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
