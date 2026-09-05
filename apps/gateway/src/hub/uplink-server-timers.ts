/**
 * hub uplink 的定时器登记处。
 *
 * 起因：`UplinkServer` 在构造时就挂上了 attachment keepalive，测试若只关库、不调 `stop()`，
 * 这个 interval 会一直烧下去，回调里读到已关闭的 SQLite 就抛 `Cannot use a closed database`——
 * 异常落在当时正好在跑的用例头上，看起来像是别人的测试挂了。
 *
 * 所以所有定时器统一登记在这里：回调里的异常只记日志不外抛；`dispose()` 一次清干净、
 * 之后再也挂不上新的；`size` 让测试可以直接断言「停机后没有残留」。
 */
import { errorMessage } from '@tmex/shared';

export interface UplinkTimer {
  clear(): void;
}

export class UplinkTimerSet {
  private readonly timers = new Set<UplinkTimer>();
  private disposed = false;

  get size(): number {
    return this.timers.size;
  }

  interval(label: string, fn: () => void, ms: number): UplinkTimer | null {
    if (this.disposed) return null;
    const id = setInterval(guard(label, fn), ms);
    return this.track(() => clearInterval(id));
  }

  timeout(label: string, fn: () => void, ms: number): UplinkTimer | null {
    if (this.disposed) return null;
    let handle: UplinkTimer | null = null;
    const run = guard(label, fn);
    const id = setTimeout(() => {
      if (handle) this.timers.delete(handle);
      run();
    }, ms);
    handle = this.track(() => clearTimeout(id));
    return handle;
  }

  /** 可被 dispose 打断的等待：停机后不会把回调拖到关库之后。 */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.timeout('sleep', resolve, ms) === null) resolve();
    });
  }

  clearAll(): void {
    for (const timer of [...this.timers]) timer.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.clearAll();
  }

  private track(clear: () => void): UplinkTimer {
    const handle: UplinkTimer = {
      clear: () => {
        if (!this.timers.delete(handle)) return;
        clear();
      },
    };
    this.timers.add(handle);
    return handle;
  }
}

/** 等待在途工作收尾，超时返回 false（调用方决定要不要告警）。 */
export async function drainWithTimeout(
  pending: Array<Promise<unknown>>,
  timers: UplinkTimerSet,
  timeoutMs: number
): Promise<boolean> {
  let timedOut = false;
  await new Promise<void>((resolve) => {
    const timer = timers.timeout(
      'stop drain',
      () => {
        timedOut = true;
        resolve();
      },
      timeoutMs
    );
    void Promise.allSettled(pending).then(() => {
      if (timedOut) return;
      timer?.clear();
      resolve();
    });
  });
  return !timedOut;
}

function guard(label: string, fn: () => void): () => void {
  return () => {
    try {
      fn();
    } catch (err) {
      console.warn(`[hub] timer ${label} failed: ${errorMessage(err)}`);
    }
  };
}
