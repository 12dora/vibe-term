// 多 node 同时展开时，`/api/files/roots` 会按分节各打一条转发 REST。
// HTTP/1.1（iOS Safari 直连 origin）只有 6 条槽，这里把并发压到 2，避免和目录列表抢连接。

export const FILE_ROOTS_FETCH_CONCURRENCY = 2;

export function createConcurrencyGate(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waiting.push(() => {
        active += 1;
        resolve();
      });
    });
  };

  const release = (): void => {
    active -= 1;
    waiting.shift()?.();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}

const runRootsFetch = createConcurrencyGate(FILE_ROOTS_FETCH_CONCURRENCY);

/** 进程内共享的 roots 拉取闸：所有 node 的 QueryClient 走同一上限。 */
export function runCappedFileRootsFetch<T>(task: () => Promise<T>): Promise<T> {
  return runRootsFetch(task);
}
