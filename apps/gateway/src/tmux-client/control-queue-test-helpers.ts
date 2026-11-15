/** 控制队列测试用的手动时钟：advance 时按到期顺序触发定时器。 */
export function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock = {
    now: () => now,
    setTimeout: (callback: () => void, delayMs: number) => {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimeout: (timer: unknown) => {
      timers.delete(timer as number);
    },
    advance: (ms: number) => {
      const target = now + ms;
      for (;;) {
        let dueId: number | null = null;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < dueAt) {
            dueId = id;
            dueAt = timer.at;
          }
        }
        if (dueId === null) break;
        const timer = timers.get(dueId);
        timers.delete(dueId);
        now = Math.max(now, dueAt);
        timer?.callback();
      }
      now = target;
    },
  };
  return clock;
}
