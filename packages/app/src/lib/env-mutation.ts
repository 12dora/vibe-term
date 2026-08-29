let chain: Promise<unknown> = Promise.resolve();

/** 串行化所有对 app.env 的读-改-写，避免 TLS 与 setup 两条路径互相覆盖对方刚写入的键。 */
export function withEnvLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}
