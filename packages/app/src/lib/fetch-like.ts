export type FetchInput = Parameters<typeof fetch>[0];
export type FetchInit = BunFetchRequestInit;

/**
 * 只保留 fetch 的可调用部分。bun 的 `typeof fetch` 还带一个 `preconnect` 静态方法，
 * 而这里所有注入点都只会调用它，所以用这个别名可以直接传普通异步函数（包装器、测试替身）。
 */
export type FetchLike = (input: FetchInput, init?: FetchInit) => Promise<Response>;
