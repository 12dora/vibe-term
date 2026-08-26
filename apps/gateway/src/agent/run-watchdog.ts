export interface RunWatchdogTimers {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export class RunWatchdog {
  private timer: unknown = null;
  private fired = false;
  private readonly setTimeoutFn: RunWatchdogTimers['setTimeout'];
  private readonly clearTimeoutFn: RunWatchdogTimers['clearTimeout'];

  constructor(
    private readonly options: {
      timeoutMs: number;
      onStall: () => void;
      timers?: RunWatchdogTimers;
    }
  ) {
    this.setTimeoutFn =
      options.timers?.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimeoutFn =
      options.timers?.clearTimeout ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  start(): void {
    this.reset();
  }

  reset(): void {
    this.clear();
    this.fired = false;
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      if (this.fired) {
        return;
      }
      this.fired = true;
      this.options.onStall();
    }, this.options.timeoutMs);
  }

  clear(): void {
    if (this.timer == null) {
      return;
    }
    this.clearTimeoutFn(this.timer);
    this.timer = null;
  }
}
