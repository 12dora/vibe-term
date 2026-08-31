// select 失败后的单次重选排队：每设备至多一个在途定时器。

export interface ReselectRetry {
  /** 已有排队时返回 false（不叠加重试） */
  schedule(deviceId: string): boolean;
  cancel(deviceId: string): void;
  dispose(): void;
}

export function createReselectRetry(
  delayMs: number,
  run: (deviceId: string) => void
): ReselectRetry {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function cancel(deviceId: string): void {
    const timer = timers.get(deviceId);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(deviceId);
  }

  return {
    schedule(deviceId) {
      if (timers.has(deviceId)) return false;
      timers.set(
        deviceId,
        setTimeout(() => {
          timers.delete(deviceId);
          run(deviceId);
        }, delayMs)
      );
      return true;
    },
    cancel,
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
