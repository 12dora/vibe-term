// chunk 404 时的整页刷新，改成「先让 waiting 的 SW 接管，再刷新」。
//
// 没有这一步的话，节点升级换掉 fe-dist 后会卡死：旧 SW 还在控制页面，导航拿到的仍是它那代
// 的壳，而新 SW 因为没有 skipWaiting 一直停在 waiting——刷多少次都是同一个 404。
// 先给 waiting 的那版发 skipWaiting，等一次 controllerchange（带超时，绝不因此卡住刷新）。

import { SW_SKIP_WAITING_MESSAGE } from './sw-messages';

/** 等 controllerchange 的上限：等不到也必须刷新，逃生通道不能自己变成新的卡点 */
export const SW_ACTIVATION_TIMEOUT_MS = 2000;

export interface WaitingWorkerLike {
  postMessage(message: unknown): void;
}

export interface SwContainerLike {
  getRegistration(): Promise<{ waiting?: WaitingWorkerLike | null } | null | undefined>;
  addEventListener(type: 'controllerchange', listener: () => void): void;
  removeEventListener(type: 'controllerchange', listener: () => void): void;
}

export interface SwReloadDeps {
  container: SwContainerLike | undefined;
  reload: () => void;
  timeoutMs?: number;
}

function waitForControllerChange(container: SwContainerLike, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      container.removeEventListener('controllerchange', done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    container.addEventListener('controllerchange', done);
  });
}

export async function activateWaitingWorkerThenReload(deps: SwReloadDeps): Promise<void> {
  const { container, reload } = deps;
  if (container) {
    try {
      const waiting = (await container.getRegistration())?.waiting;
      if (waiting) {
        const changed = waitForControllerChange(
          container,
          deps.timeoutMs ?? SW_ACTIVATION_TIMEOUT_MS
        );
        waiting.postMessage({ type: SW_SKIP_WAITING_MESSAGE });
        await changed;
      }
    } catch {
      // 拿不到注册信息就直接刷新，别把逃生通道自己堵死
    }
  }
  reload();
}

/** lazy chunk / 弹层 chunk 取不到时的默认刷新实现 */
export function reloadAfterServiceWorkerUpdate(): void {
  const nav = (globalThis as { navigator?: { serviceWorker?: SwContainerLike } }).navigator;
  void activateWaitingWorkerThenReload({
    container: nav?.serviceWorker,
    reload: () => window.location.reload(),
  });
}
