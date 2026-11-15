import { describe, expect, test } from 'bun:test';
import {
  NAV_REFRESH_INTERVAL_MS,
  type NavRefreshOutcome,
  type NavRefresherDeps,
  createNavTicketRefresher,
  retryDelayMs,
} from './nav-ticket-refresher';

const NODE_B = 'b'.repeat(32);

function harness(initial: string[] = ['self']) {
  let now = 1_000_000;
  let ids = initial;
  const timers: Array<{ run: () => void; ms: number; live: boolean }> = [];
  const refreshed: string[] = [];
  const outcomes = new Map<string, NavRefreshOutcome[]>();
  let nodesListener: ((added: string | null) => Promise<void> | void) | null = null;
  let visible: (() => void) | null = null;
  const deps: NavRefresherDeps = {
    loaded: () => Promise.resolve(),
    nodeIds: () => ids,
    onNodesChange: (listener) => {
      nodesListener = listener;
      return () => {
        nodesListener = null;
      };
    },
    refresh: (nodeId) => {
      refreshed.push(nodeId);
      return Promise.resolve(outcomes.get(nodeId)?.shift() ?? 'ok');
    },
    setTimer: (run, ms) => {
      const timer = { run, ms, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { live: boolean }).live = false;
    },
    now: () => now,
    onVisible: (listener) => {
      visible = listener;
      return () => {
        visible = null;
      };
    },
  };
  const refresher = createNavTicketRefresher(deps);
  return {
    refresher,
    refreshed,
    outcomes,
    timers,
    liveTimer: () => timers.filter((timer) => timer.live).at(-1),
    advance: (ms: number) => {
      now += ms;
    },
    setIds: (next: string[]) => {
      ids = next;
    },
    added: (id: string) => nodesListener?.(id),
    changed: () => nodesListener?.(null),
    becomeVisible: () => visible?.(),
    isListening: () => nodesListener !== null,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('retryDelayMs', () => {
  test('无失败走常规 4 分钟；失败按 5s、15s、45s… 退避，封顶 4 分钟', () => {
    expect(retryDelayMs(0)).toBe(NAV_REFRESH_INTERVAL_MS);
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([
      5_000,
      15_000,
      45_000,
      135_000,
      NAV_REFRESH_INTERVAL_MS,
    ]);
  });
});

describe('createNavTicketRefresher', () => {
  test('启动即对全部 PoP node 续一轮，之后每 4 分钟一次', async () => {
    const h = harness(['self', NODE_B]);
    h.refresher.start();
    await h.refresher.ready();
    expect(h.refreshed).toEqual(['self', NODE_B]);
    expect(h.liveTimer()?.ms).toBe(NAV_REFRESH_INTERVAL_MS);

    h.liveTimer()?.run();
    await settle();
    expect(h.refreshed).toEqual(['self', NODE_B, 'self', NODE_B]);
    expect(h.liveTimer()?.ms).toBe(NAV_REFRESH_INTERVAL_MS);
  });

  test('没有 PoP node：不排定时器，ready 照常完成', async () => {
    const h = harness([]);
    h.refresher.start();
    await h.refresher.ready();
    expect(h.refreshed).toEqual([]);
    expect(h.liveTimer()).toBeUndefined();
  });

  test('失败只退避重试：5s → 15s，恢复后回到 4 分钟', async () => {
    const h = harness(['self']);
    h.outcomes.set('self', ['failed', 'failed', 'ok']);
    h.refresher.start();
    await h.refresher.ready();
    expect(h.liveTimer()?.ms).toBe(5_000);

    h.liveTimer()?.run();
    await settle();
    expect(h.liveTimer()?.ms).toBe(15_000);

    h.liveTimer()?.run();
    await settle();
    expect(h.liveTimer()?.ms).toBe(NAV_REFRESH_INTERVAL_MS);
    expect(h.refreshed).toEqual(['self', 'self', 'self']);
  });

  test('refresh 抛异常按失败处理，不抛出、不停摆', async () => {
    let calls = 0;
    const throwing = createNavTicketRefresher({
      loaded: () => Promise.resolve(),
      nodeIds: () => ['self'],
      onNodesChange: () => () => undefined,
      refresh: () => {
        calls += 1;
        return Promise.reject(new Error('offline'));
      },
      setTimer: (run, ms) => ({ run, ms }),
      clearTimer: () => undefined,
      now: () => 0,
      onVisible: () => () => undefined,
    });
    throwing.start();
    await throwing.ready();
    expect(calls).toBe(1);
  });

  test('404：标记该 node 没有导航凭证端点，不再续', async () => {
    const h = harness(['self', NODE_B]);
    h.outcomes.set(NODE_B, ['absent']);
    h.refresher.start();
    await h.refresher.ready();
    h.liveTimer()?.run();
    await settle();
    expect(h.refreshed).toEqual(['self', NODE_B, 'self']);
  });

  test('新登录的 node 立即续一次，并清掉它之前的 404 / 失败记录', async () => {
    const h = harness(['self']);
    h.refresher.start();
    await h.refresher.ready();
    h.setIds(['self', NODE_B]);
    await h.added(NODE_B);
    expect(h.refreshed).toEqual(['self', NODE_B]);
  });

  test('最后一个 node 没了：定时器清掉', async () => {
    const h = harness(['self']);
    h.refresher.start();
    await h.refresher.ready();
    h.setIds([]);
    h.changed();
    expect(h.liveTimer()).toBeUndefined();
  });

  test('页面重新可见：距上次超过 4 分钟才续', async () => {
    const h = harness(['self']);
    h.refresher.start();
    await h.refresher.ready();
    h.advance(NAV_REFRESH_INTERVAL_MS - 1);
    h.becomeVisible();
    await settle();
    expect(h.refreshed).toEqual(['self']);

    h.advance(2);
    h.becomeVisible();
    await settle();
    expect(h.refreshed).toEqual(['self', 'self']);
  });

  test('start 幂等；stop 摘掉监听与定时器', async () => {
    const h = harness(['self']);
    h.refresher.start();
    h.refresher.start();
    await h.refresher.ready();
    expect(h.refreshed).toEqual(['self']);
    h.refresher.stop();
    expect(h.isListening()).toBe(false);
    expect(h.liveTimer()).toBeUndefined();
  });
});
