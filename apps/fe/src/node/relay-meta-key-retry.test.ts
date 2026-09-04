// 宿主级 meta-key 欠账重发：挂上中继才动手、只重发手上有字节的那些、退避有上限。

import { afterEach, describe, expect, test } from 'bun:test';
import { resetMeshRelayStateForTest, setMeshRelayStateForTest } from './mesh-relay';
import type { RelayFlowDeps } from './relay-enroll';
import { clearPendingMetaKeysForTest, rememberPendingMetaKey } from './relay-meta-key-pending';
import { startRelayMetaKeyRetry } from './relay-meta-key-retry';

const RECORD = { type: 'meta-key' as const, bytes: 'YWJj', sig: 'ZGVm' };
const DEPS = { mode: { uid: 'u1' } } as unknown as RelayFlowDeps;

function fakeDelay() {
  const queue: { ms: number; fn: () => void }[] = [];
  const delay = (fn: () => void, ms: number) => {
    const entry = { ms, fn };
    queue.push(entry);
    return () => {
      const at = queue.indexOf(entry);
      if (at >= 0) queue.splice(at, 1);
    };
  };
  const run = async () => {
    const next = queue.shift();
    if (!next) return false;
    next.fn();
    await Promise.resolve();
    await Promise.resolve();
    return true;
  };
  return { delay, queue, run };
}

function attach(url = 'https://relay.example', online = false): void {
  setMeshRelayStateForTest({
    mode: 'relay',
    relays: [
      {
        url,
        priority: 0,
        attached: true,
        online,
      } as never,
    ],
  });
}

function remember(id: string, withRecord: boolean): void {
  rememberPendingMetaKey({
    id,
    reason: 'revoke',
    op: { op: 'rotate' },
    ...(withRecord ? { record: RECORD } : {}),
  });
}

afterEach(() => {
  clearPendingMetaKeysForTest();
  resetMeshRelayStateForTest();
});

describe('startRelayMetaKeyRetry', () => {
  test('挂上中继后按退避重发，落账即收工', async () => {
    const timers = fakeDelay();
    let calls = 0;
    attach();
    remember('revoke:a', true);
    let settled = 0;
    const stop = startRelayMetaKeyRetry({
      deps: DEPS,
      backoffMs: [1, 2, 3],
      delay: timers.delay,
      acquirePolling: () => () => undefined,
      retry: () => {
        calls += 1;
        clearPendingMetaKeysForTest();
        return Promise.resolve(0);
      },
      onSettled: () => {
        settled += 1;
      },
    });

    expect(timers.queue).toHaveLength(1);
    expect(await timers.run()).toBe(true);
    expect(calls).toBe(1);
    expect(settled).toBe(1);
    expect(timers.queue).toHaveLength(0);
    stop();
  });

  test('没挂上中继不重发，挂上之后立刻起一轮', async () => {
    const timers = fakeDelay();
    let calls = 0;
    remember('revoke:a', true);
    const stop = startRelayMetaKeyRetry({
      deps: DEPS,
      backoffMs: [1],
      delay: timers.delay,
      acquirePolling: () => () => undefined,
      retry: () => {
        calls += 1;
        return Promise.resolve(1);
      },
    });

    expect(timers.queue).toHaveLength(0);
    attach();
    expect(timers.queue).toHaveLength(1);
    await timers.run();
    expect(calls).toBe(1);
    stop();
  });

  test('只签不成的欠账（没有字节）不自动重发', () => {
    const timers = fakeDelay();
    attach();
    remember('revoke:a', false);
    const stop = startRelayMetaKeyRetry({
      deps: DEPS,
      backoffMs: [1],
      delay: timers.delay,
      acquirePolling: () => () => undefined,
      retry: () => Promise.reject(new Error('不该被调用')),
    });

    expect(timers.queue).toHaveLength(0);
    stop();
  });

  test('退避有上限：一批欠账最多试 backoff.length 次', async () => {
    const timers = fakeDelay();
    let calls = 0;
    attach();
    remember('revoke:a', true);
    const stop = startRelayMetaKeyRetry({
      deps: DEPS,
      backoffMs: [1, 2, 3],
      delay: timers.delay,
      acquirePolling: () => () => undefined,
      retry: () => {
        calls += 1;
        return Promise.resolve(1);
      },
    });

    while (await timers.run()) {
      // 跑干所有已排的重试
    }
    expect(calls).toBe(3);
    stop();
  });

  test('欠账期间取用中继轮询，清空后归还', () => {
    const timers = fakeDelay();
    let acquired = 0;
    let released = 0;
    attach();
    remember('revoke:a', true);
    const stop = startRelayMetaKeyRetry({
      deps: DEPS,
      backoffMs: [1],
      delay: timers.delay,
      acquirePolling: () => {
        acquired += 1;
        return () => {
          released += 1;
        };
      },
      retry: () => Promise.resolve(1),
    });

    expect(acquired).toBe(1);
    clearPendingMetaKeysForTest();
    expect(released).toBe(1);
    stop();
  });

  test('停止后不再排新的重试', async () => {
    const timers = fakeDelay();
    let calls = 0;
    attach();
    remember('revoke:a', true);
    const stop = startRelayMetaKeyRetry({
      deps: DEPS,
      backoffMs: [1, 2],
      delay: timers.delay,
      acquirePolling: () => () => undefined,
      retry: () => {
        calls += 1;
        return Promise.resolve(1);
      },
    });

    stop();
    expect(timers.queue).toHaveLength(0);
    remember('revoke:b', true);
    expect(calls).toBe(0);
  });
  test('链路恢复在线：退避重开一轮并立刻重试一次', async () => {
    const timers = fakeDelay();
    let calls = 0;
    attach();
    remember('revoke:a', true);
    const stop = startRelayMetaKeyRetry({
      deps: DEPS,
      backoffMs: [1],
      delay: timers.delay,
      acquirePolling: () => () => undefined,
      retry: () => {
        calls += 1;
        return Promise.resolve(1);
      },
    });

    // 一档退避走完就停手
    while (await timers.run()) {
      // 跑干
    }
    expect(calls).toBe(1);

    attach('https://relay.example', true);
    // 立刻重试，不必再等第一档
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
    stop();
  });

  test('无缝切到另一台中继：同样重开一轮', async () => {
    const timers = fakeDelay();
    let calls = 0;
    attach('https://a.example', true);
    remember('revoke:a', true);
    const stop = startRelayMetaKeyRetry({
      deps: DEPS,
      backoffMs: [1],
      delay: timers.delay,
      acquirePolling: () => () => undefined,
      retry: () => {
        calls += 1;
        return Promise.resolve(1);
      },
    });
    while (await timers.run()) {
      // 跑干
    }
    expect(calls).toBe(1);

    attach('https://b.example', true);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
    stop();
  });
});
