// hub 管理面（`/n/<hub>/api/hub/nodes`）的轮询：这条链路没有事件流，只能定时拉，但它是
// **跨节点** REST（走 peer 直连或 hub 中转），后台标签页每 30 秒唤醒一次射频毫无意义。
// 可见性门与 `mesh-nodes` / `mesh-hubs` 的兜底轮询同一套范式。

/** hub 管理面的轮询间隔：它没有事件流，保持 30 秒。 */
export const HUB_POLL_MS = 30_000;

/** 回到前台判定「列表已经旧了」的阈值：一拍没拉到就该补。 */
export const HUB_STALE_MS = HUB_POLL_MS;

export interface PageVisibility {
  hidden: () => boolean;
  subscribe: (listener: () => void) => () => void;
}

/** 取不到 document（SSR / 单测）时一律按「可见」处理。 */
export function browserVisibility(): PageVisibility {
  return {
    hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    subscribe: (listener) => {
      if (typeof document === 'undefined') return () => undefined;
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
}

export interface HubPollingOptions {
  intervalMs: number;
  /** 一拍的动作（拉列表）。 */
  load: () => void;
  /** 回到前台判定「已经旧了」的阈值；缺省 `HUB_STALE_MS`。 */
  staleMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
  visibility?: PageVisibility;
}

/**
 * 轮询回路：
 *  - 页面隐藏期间跳过这一拍；
 *  - 重新可见时距上次拉取已超过 `staleMs` 就立刻补一次，不必等下一拍。
 */
export function startHubPolling(options: HubPollingOptions): () => void {
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? HUB_STALE_MS;
  const visibility = options.visibility ?? browserVisibility();
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    });

  // 挂载时的首拉由 useHubNode 的加载 effect 负责，这里从「刚拉过」起算。
  let lastLoadAt = now();
  const run = () => {
    lastLoadAt = now();
    options.load();
  };

  const stopTimer = schedule(() => {
    if (visibility.hidden()) return;
    run();
  }, options.intervalMs);

  const stopVisibility = visibility.subscribe(() => {
    if (visibility.hidden()) return;
    if (now() - lastLoadAt >= staleMs) run();
  });

  return () => {
    stopTimer();
    stopVisibility();
  };
}
