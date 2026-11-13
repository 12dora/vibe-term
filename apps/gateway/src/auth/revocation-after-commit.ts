import type { AuthDb } from './types';

type Job = () => void;

let pending: Job[] | null = null;
let commitDb: AuthDb | null = null;

/** key log 事务内排队；事务外立即执行。回滚时队列丢弃，不拆运行态。 */
export function runAfterKeyLogCommit(job: Job): void {
  if (pending) pending.push(job);
  else job();
}

/** 提交后的监听器应打外层库连接，不要用事务回调里的 `tx`。 */
export function keyLogCommitDb(): AuthDb | null {
  return commitDb;
}

export function withKeyLogCommitSideEffects<T>(db: AuthDb, work: () => T): T {
  if (pending) return work();
  const jobs: Job[] = [];
  const previousDb = commitDb;
  pending = jobs;
  commitDb = db;
  try {
    const result = work();
    pending = null;
    for (const job of jobs) {
      try {
        job();
      } catch (error) {
        console.error('[auth] revocation side effect failed:', error);
      }
    }
    return result;
  } catch (error) {
    pending = null;
    throw error;
  } finally {
    commitDb = previousDb;
  }
}
