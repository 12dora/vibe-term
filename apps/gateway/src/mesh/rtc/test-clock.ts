export class FakeClock {
  nowMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  now = (): number => this.nowMs;

  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + Math.max(0, ms), fn });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    if (typeof handle === 'number') this.timers.delete(handle);
  };

  advance(ms: number): void {
    const target = this.nowMs + Math.max(0, ms);
    while (this.timers.size > 0) {
      let earliestId: number | null = null;
      let earliestAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at < earliestAt) {
          earliestAt = timer.at;
          earliestId = id;
        }
      }
      if (earliestId === null || earliestAt > target) break;
      this.nowMs = earliestAt;
      const timer = this.timers.get(earliestId);
      this.timers.delete(earliestId);
      timer?.fn();
    }
    this.nowMs = target;
  }
}
