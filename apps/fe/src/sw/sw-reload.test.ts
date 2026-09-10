// 逃生通道：有 waiting 的 SW 就先让它接管再刷新；没有 / 拿不到 / 等不到都必须照常刷新。

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SW_SKIP_WAITING_MESSAGE } from './sw-messages';
import {
  type SwContainerLike,
  type WaitingWorkerLike,
  activateWaitingWorkerThenReload,
} from './sw-reload';

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
    fireControllerChange: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

describe('activateWaitingWorkerThenReload', () => {
  test('有 waiting：发 skipWaiting，等到 controllerchange 后刷新', async () => {
    const posted: unknown[] = [];
    const harness = container({ postMessage: (m) => posted.push(m) });
    let reloaded = 0;
    const done = activateWaitingWorkerThenReload({
      container: harness.impl,
      reload: () => {
        reloaded += 1;
      },
      timeoutMs: 5000,
    });
    // 消息在等待注册之后才发出，先让出一轮微任务
    await Promise.resolve();
    await Promise.resolve();
    expect(posted).toEqual([{ type: SW_SKIP_WAITING_MESSAGE }]);
    expect(reloaded).toBe(0);
    harness.fireControllerChange();
    await done;
    expect(reloaded).toBe(1);
    expect(harness.listeners.size).toBe(0);
  });

  test('等不到 controllerchange 也在超时后刷新', async () => {
    const harness = container({ postMessage: () => undefined });
    let reloaded = 0;
    await activateWaitingWorkerThenReload({
      container: harness.impl,
      reload: () => {
        reloaded += 1;
      },
      timeoutMs: 1,
    });
    expect(reloaded).toBe(1);
    expect(harness.listeners.size).toBe(0);
  });

  test('没有 waiting：直接刷新，不发消息', async () => {
    const harness = container(null);
    let reloaded = 0;
    await activateWaitingWorkerThenReload({
      container: harness.impl,
      reload: () => {
        reloaded += 1;
      },
    });
    expect(reloaded).toBe(1);
    expect(harness.listeners.size).toBe(0);
  });

  test('浏览器不支持 serviceWorker：直接刷新', async () => {
    let reloaded = 0;
    await activateWaitingWorkerThenReload({
      container: undefined,
      reload: () => {
        reloaded += 1;
      },
    });
    expect(reloaded).toBe(1);
  });

  test('getRegistration 抛错也照常刷新', async () => {
    let reloaded = 0;
    await activateWaitingWorkerThenReload({
      container: {
        getRegistration: () => Promise.reject(new Error('nope')),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
      reload: () => {
        reloaded += 1;
      },
    });
    expect(reloaded).toBe(1);
  });
});

describe('SW_SKIP_WAITING_MESSAGE', () => {
  test('packages/ui 抄写的那份字面量必须一致（改一边就静默失效）', () => {
    expect(SW_SKIP_WAITING_MESSAGE).toBe('vibeterm:sw-skip-waiting');
    const overlay = readFileSync(
      join(import.meta.dir, '../../../../packages/ui/src/lazy-overlay.tsx'),
      'utf8'
    );
    expect(overlay).toContain(`const SW_SKIP_WAITING_MESSAGE = '${SW_SKIP_WAITING_MESSAGE}';`);
  });
});
