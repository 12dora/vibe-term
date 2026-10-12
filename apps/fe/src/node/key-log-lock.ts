/**
 * key log 写锁：**宿主级**一条 FIFO 链。
 *
 * head 是全局的，`keyLogHead → 构造签名 → append` 必须整段串行：两条不同 enrollment 的 admit
 * 若并行读到同一个 head，就会造出两条同 seq 的记录，对端只收得下一条，另一条永久 `seq_gap`
 * （见 R4 #1）。按 enrollment 上锁挡不住这种情况。
 *
 * admit 之外的写入方（吊销在 `use-node-row-actions.ts`、中继的 `meta-key` / `set-relays`）与 admit
 * 抢同一个 head，不进这条链照样撞（见 R5 #1）。**只圈住取 head → 签名 → append**，凭据对话框留锁外。
 */
let keyLogQueue: Promise<unknown> = Promise.resolve();

export function withKeyLogLock<T>(run: () => Promise<T>): Promise<T> {
  const result = keyLogQueue.then(run, run);
  keyLogQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export function resetKeyLogLockForTest(): void {
  keyLogQueue = Promise.resolve();
}
