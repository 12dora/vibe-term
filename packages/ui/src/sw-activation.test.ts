// 换代握手：有 waiting 就发 skipWaiting 并等 controllerchange；没有 / 不支持 / 等超时都必须放行。
// 放行失败就等于整个逃生通道卡死，所以每条分支都要钉住。

import { describe, expect, test } from 'bun:test';
import {
  SW_SKIP_WAITING_MESSAGE,
  type SwContainerLike,
  type WaitingWorkerLike,
  activateWaitingWorker,
} from './sw-activation';

function container(waiting: WaitingWorkerLike | null) {
  const listeners = new Set<() => void>();
  const impl: SwContainerLike = {
    getRegistration: async () => ({ waiting }),
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  return {
    impl,
    listeners,
    fire: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

describe('activateWaitingWorker', () => {
  test('有 waiting：发 skipWaiting、等 controllerchange，之后摘掉监听', async () => {
    const posted: unknown[] = [];
    const harness = container({ postMessage: (message) => posted.push(message) });
    const done = activateWaitingWorker(harness.impl, 5000);
    await Promise.resolve();
    await Promise.resolve();
    expect(posted).toEqual([{ type: SW_SKIP_WAITING_MESSAGE }]);
    harness.fire();
    await done;
    expect(harness.listeners.size).toBe(0);
  });

  test('等不到 controllerchange 也在超时后放行', async () => {
    const harness = container({ postMessage: () => undefined });
    await activateWaitingWorker(harness.impl, 1);
    expect(harness.listeners.size).toBe(0);
  });

  test('没有 waiting 时立即放行，不发消息', async () => {
    const harness = container(null);
    await activateWaitingWorker(harness.impl, 5000);
    expect(harness.listeners.size).toBe(0);
  });

  test('不支持 serviceWorker 时立即放行', async () => {
    await activateWaitingWorker(undefined, 5000);
  });

  test('getRegistration 抛错也放行', async () => {
    await activateWaitingWorker(
      {
        getRegistration: () => Promise.reject(new Error('nope')),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
      5000
    );
  });
});
