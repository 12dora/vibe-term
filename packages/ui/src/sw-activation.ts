// 应用壳 Service Worker 换代时的页面侧握手。放在 packages/ui：apps/fe 的 chunk 逃生通道
// （lazy-chunk.tsx / sw/sw-reload.ts）与本包的弹层逃生通道（lazy-overlay.tsx）必须用同一份
// 消息名，抄两遍迟早会改歪。本模块不依赖 React，SW 侧（apps/fe/src/sw/sw.ts）也直接引它。

/** 页面 → waiting SW：立刻接管。sw.ts 的 message 监听只认这一个 type。 */
export const SW_SKIP_WAITING_MESSAGE = 'vibeterm:sw-skip-waiting';

/**
 * SW → 页面：这次导航回放的是**上一代**缓存壳（网络预算超时走了兜底）。页面据此把「下一个
 * 安全时刻换代」的旗子立起来——新一代可能是上一次会话里装好的，这一代页面压根收不到
 * `updatefound`，没有这条消息就只能一直看旧 UI。
 */
export const SW_SHELL_STALE_MESSAGE = 'vibeterm:sw-shell-stale';

/** 等 controllerchange 的上限：等不到也必须放行，逃生通道不能自己变成新的卡点 */
export const SW_ACTIVATION_TIMEOUT_MS = 2000;

export interface WaitingWorkerLike {
  postMessage(message: unknown): void;
}

export interface SwContainerLike {
  getRegistration(): Promise<{ waiting?: WaitingWorkerLike | null } | null | undefined>;
  addEventListener(type: 'controllerchange', listener: () => void): void;
  removeEventListener(type: 'controllerchange', listener: () => void): void;
}

/**
 * 刷新前先让 waiting 的 SW 接管：发版换掉 fe-dist 后旧 SW 还控制着页面，光刷新只会再拿到
 * 它那代的壳、再撞一次同样的 404。没有 waiting / 不支持 / 等超时都直接放行。
 */
export async function activateWaitingWorker(
  container: SwContainerLike | undefined,
  timeoutMs = SW_ACTIVATION_TIMEOUT_MS
): Promise<void> {
  try {
    const waiting = (await container?.getRegistration())?.waiting;
    if (!container || !waiting) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        container.removeEventListener('controllerchange', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      container.addEventListener('controllerchange', done);
      waiting.postMessage({ type: SW_SKIP_WAITING_MESSAGE });
    });
  } catch {
    // 拿不到注册信息就直接放行，别把逃生通道自己堵死
  }
}

/** 浏览器宿主的默认实现：拿 navigator.serviceWorker 走一遍握手 */
export function activateWaitingWorkerFromBrowser(): Promise<void> {
  const nav = (globalThis as { navigator?: { serviceWorker?: SwContainerLike } }).navigator;
  return activateWaitingWorker(nav?.serviceWorker);
}
