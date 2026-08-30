// `useHubNode` 取数时序的回归测试：初次加载 / 轮询 / 手动刷新交错时的代号与单飞。
// 仓库没有 DOM 测试环境（effect 跑不起来），所以时序逻辑放在 React 之外的协调器里单测。

import { describe, expect, test } from 'bun:test';
import type { HubNodeRow } from './hub-api';
import { HubLoadCoordinator, type HubRequest } from './hub-load-coordinator';

function row(id: string): HubNodeRow {
  return {
    id,
    name: id,
    status: 'active',
    online: true,
    version: null,
    last_seen_at: null,
    direct_capable: false,
  };
}

interface Deferred {
  request: HubRequest;
  calls: number;
  resolve: (rows: HubNodeRow[]) => void;
  reject: (err: unknown) => void;
}

/** 一个手动落定的请求闭包；`calls` 记录实际发起的次数（单飞的可观测形式）。 */
function deferred(): Deferred {
  const state = {
    calls: 0,
    resolve: (_rows: HubNodeRow[]) => {},
    reject: (_err: unknown) => {},
  };
  const request: HubRequest = () => {
    state.calls += 1;
    return new Promise<HubNodeRow[]>((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
    });
  };
  return {
    request,
    get calls() {
      return state.calls;
    },
    resolve: (rows) => state.resolve(rows),
    reject: (err) => state.reject(err),
  };
}

interface Recorder {
  sink: ConstructorParameters<typeof HubLoadCoordinator>[0];
  events: string[];
  rows: HubNodeRow[] | null;
  loading: boolean;
  error: string | null;
}

function recorder(): Recorder {
  const state: Recorder = {
    events: [],
    rows: null,
    loading: false,
    error: null,
    sink: {
      loading: (value) => {
        state.events.push(`loading:${value}`);
        state.loading = value;
      },
      reset: () => {
        state.events.push('reset');
        state.rows = null;
        state.loading = false;
      },
      rows: (rows) => {
        state.events.push(`rows:${rows.map((item) => item.id).join(',')}`);
        state.rows = rows;
        state.error = null;
      },
      failed: (message) => {
        state.events.push(`failed:${message}`);
        state.rows = null;
        state.error = message;
      },
    },
  };
  return state;
}

/** 让已落定的 promise 链跑完（协调器内部有 await + finally 两层微任务）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

describe('HubLoadCoordinator', () => {
  test('慢的旧响应不会盖掉后到的新响应', async () => {
    const sink = recorder();
    const coordinator = new HubLoadCoordinator(sink.sink);
    const slow = deferred();
    const fast = deferred();

    const first = coordinator.load(slow.request);
    const second = coordinator.load(fast.request);

    fast.resolve([row('new')]);
    await second;
    expect(sink.rows?.map((item) => item.id)).toEqual(['new']);
    expect(sink.loading).toBe(false);

    slow.resolve([row('old')]);
    await first;
    await flush();
    expect(sink.rows?.map((item) => item.id)).toEqual(['new']);
    expect(sink.events).not.toContain('rows:old');
  });

  test('过期响应的失败不会写 error，也不会提前停掉 loading', async () => {
    const sink = recorder();
    const coordinator = new HubLoadCoordinator(sink.sink);
    const slow = deferred();
    const pending = deferred();

    const first = coordinator.load(slow.request);
    coordinator.load(pending.request);

    slow.reject(new Error('stale failure'));
    await first;
    await flush();

    expect(sink.error).toBeNull();
    expect(sink.loading).toBe(true);
    expect(sink.events).toEqual(['loading:true', 'loading:true']);
  });

  test('同一个请求在飞时并发调用合并成一次（轮询中手动刷新）', async () => {
    const sink = recorder();
    const coordinator = new HubLoadCoordinator(sink.sink);
    const poll = deferred();

    const fromPoll = coordinator.load(poll.request);
    const fromRefresh = coordinator.load(poll.request);
    expect(fromRefresh).toBe(fromPoll);
    expect(poll.calls).toBe(1);

    poll.resolve([row('hub')]);
    await fromPoll;
    expect(sink.rows?.map((item) => item.id)).toEqual(['hub']);

    // 在飞的那次落定之后，同一个请求可以再发一轮（下一次轮询）。
    const next = coordinator.load(poll.request);
    expect(poll.calls).toBe(2);
    poll.resolve([row('hub2')]);
    await next;
    expect(sink.rows?.map((item) => item.id)).toEqual(['hub2']);
  });

  test('卸载后到达的响应不写任何状态', async () => {
    const sink = recorder();
    const coordinator = new HubLoadCoordinator(sink.sink);
    const inFlight = deferred();

    const promise = coordinator.load(inFlight.request);
    expect(sink.events).toEqual(['loading:true']);

    coordinator.dispose();
    inFlight.resolve([row('late')]);
    await promise;
    await flush();

    expect(sink.events).toEqual(['loading:true']);
    expect(sink.rows).toBeNull();
    expect(sink.error).toBeNull();
  });

  test('卸载中途失败同样不写 error', async () => {
    const sink = recorder();
    const coordinator = new HubLoadCoordinator(sink.sink);
    const inFlight = deferred();

    const promise = coordinator.load(inFlight.request);
    coordinator.dispose();
    inFlight.reject(new Error('boom'));
    await promise;
    await flush();

    expect(sink.error).toBeNull();
    expect(sink.events).toEqual(['loading:true']);
  });

  test('重新挂载后恢复写状态', async () => {
    const sink = recorder();
    const coordinator = new HubLoadCoordinator(sink.sink);
    const before = deferred();

    const stale = coordinator.load(before.request);
    coordinator.dispose();
    coordinator.activate();

    const after = deferred();
    const fresh = coordinator.load(after.request);
    before.resolve([row('stale')]);
    after.resolve([row('fresh')]);
    await Promise.all([stale, fresh]);
    await flush();

    expect(sink.rows?.map((item) => item.id)).toEqual(['fresh']);
  });

  test('请求失败写 error 并清空列表', async () => {
    const sink = recorder();
    const coordinator = new HubLoadCoordinator(sink.sink);
    const failing = deferred();

    const promise = coordinator.load(failing.request);
    failing.reject(new Error('hub unreachable'));
    await promise;

    expect(sink.error).toBe('hub unreachable');
    expect(sink.rows).toBeNull();
    expect(sink.loading).toBe(false);
  });

  test('没有可用 hub 时清空列表且不留在 loading', async () => {
    const sink = recorder();
    const coordinator = new HubLoadCoordinator(sink.sink);
    const ok = deferred();

    const promise = coordinator.load(ok.request);
    ok.resolve([row('hub')]);
    await promise;

    await coordinator.load(null);
    expect(sink.rows).toBeNull();
    expect(sink.loading).toBe(false);
    expect(sink.events.at(-1)).toBe('reset');
  });

  test('切到 null 之后的旧响应不再写状态', async () => {
    const sink = recorder();
    const coordinator = new HubLoadCoordinator(sink.sink);
    const slow = deferred();

    const promise = coordinator.load(slow.request);
    await coordinator.load(null);
    slow.resolve([row('old')]);
    await promise;
    await flush();

    expect(sink.rows).toBeNull();
    expect(sink.events).toEqual(['loading:true', 'reset']);
  });
});
