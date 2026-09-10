import { beforeEach, describe, expect, test } from 'bun:test';
import {
  GIVE_UP_RECONNECT_MS,
  type NodeReloginResult,
  NodeSessionGuard,
  type NodeSessionProbe,
} from './node-session-guard';

const NODE_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';

interface Harness {
  guard: NodeSessionGuard;
  reconnected: string[];
  loginRequired: string[];
  loggedOut: string[];
  relogins: string[];
  probes: string[];
  delays: number[];
  advance: (ms: number) => void;
  setNow: (at: number) => void;
}

interface HarnessOptions {
  probe?: (nodeId: string) => Promise<NodeSessionProbe>;
  relogin?: (nodeId: string) => Promise<NodeReloginResult>;
  reconnectDelayFloorMs?: (nodeId: string) => number;
  maxTransient?: number;
  windowMs?: number;
}

function harness(options: HarnessOptions = {}): Harness {
  const reconnected: string[] = [];
  const loginRequired: string[] = [];
  const loggedOut: string[] = [];
  const relogins: string[] = [];
  const probes: string[] = [];
  const delays: number[] = [];
  let now = 1_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();

  const guard = new NodeSessionGuard({
    probe: (nodeId) => {
      probes.push(nodeId);
      return (options.probe ?? (() => Promise.resolve<NodeSessionProbe>('ok')))(nodeId);
    },
    ...(options.relogin
      ? {
          relogin: (nodeId: string) => {
            relogins.push(nodeId);
            return options.relogin?.(nodeId) ?? Promise.resolve<NodeReloginResult>('failed');
          },
        }
      : {}),
    ...(options.reconnectDelayFloorMs
      ? { reconnectDelayFloorMs: options.reconnectDelayFloorMs }
      : {}),
    reconnect: (nodeId) => reconnected.push(nodeId),
    onLoginRequired: (nodeId) => loginRequired.push(nodeId),
    markLoggedOut: (nodeId) => loggedOut.push(nodeId),
    schedule: (fn, ms) => {
      delays.push(ms);
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    cancel: (handle) => {
      timers.delete(handle as number);
    },
    now: () => now,
    ...(options.maxTransient === undefined ? {} : { maxTransient: options.maxTransient }),
    ...(options.windowMs === undefined ? {} : { windowMs: options.windowMs }),
  });

  const fire = () => {
    for (const [id, timer] of [...timers.entries()]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.fn();
      }
    }
  };

  return {
    guard,
    reconnected,
    loginRequired,
    loggedOut,
    relogins,
    probes,
    delays,
    advance: (ms) => {
      now += ms;
      fire();
    },
    setNow: (at) => {
      now = at;
      fire();
    },
  };
}

describe('NodeSessionGuard', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  test('探测成功 = 瞬时故障：不判未登录，退避后重连', async () => {
    await h.guard.handle(NODE_A);
    expect(h.loginRequired).toEqual([]);
    expect(h.loggedOut).toEqual([]);
    expect(h.reconnected).toEqual([]);
    h.advance(1_000);
    expect(h.reconnected).toEqual([NODE_A]);
  });

  test('重连退避逐次翻倍', async () => {
    await h.guard.handle(NODE_A);
    h.advance(1_000);
    await h.guard.handle(NODE_A);
    h.advance(1_000);
    expect(h.reconnected).toEqual([NODE_A]);
    h.advance(1_000);
    expect(h.reconnected).toEqual([NODE_A, NODE_A]);
  });

  test('重连间隔取宿主给的下限（该 node 的不可达退避还剩多久）', async () => {
    const g = harness({
      probe: () => Promise.resolve('unreachable'),
      reconnectDelayFloorMs: () => 120_000,
    });
    await g.guard.handle(NODE_A);
    expect(g.delays).toEqual([120_000]);
    g.advance(119_000);
    expect(g.reconnected).toEqual([]);
    g.advance(1_000);
    expect(g.reconnected).toEqual([NODE_A]);
  });
});

describe('判定该 node 要重新登录（给用户留出口）', () => {
  test('连续 N 次「探测说没问题、WS 仍被踢」：只派事件 + 慢速重连，不动登录态', async () => {
    const g = harness({ maxTransient: 2 });
    await g.guard.handle(NODE_A);
    g.advance(1_000);
    await g.guard.handle(NODE_A);
    g.advance(2_000);
    expect(g.loginRequired).toEqual([]);

    await g.guard.handle(NODE_A);
    expect(g.loginRequired).toEqual([NODE_A]);
    // HTTP 已经证明会话有效：把它标成未登录属于拿不出证据的结论。
    expect(g.loggedOut).toEqual([]);

    const before = g.reconnected.length;
    g.advance(GIVE_UP_RECONNECT_MS - 1_000);
    expect(g.reconnected).toHaveLength(before);
    g.advance(1_000);
    // 判定之后仍留一条慢速重连：链路自己好了，用户什么都不用点。
    expect(g.reconnected).toHaveLength(before + 1);
  });

  test('resume（页面重新可见 / 网络恢复）立刻重试并倒回计数', async () => {
    const g = harness({ maxTransient: 1 });
    await g.guard.handle(NODE_A);
    g.advance(1_000);
    await g.guard.handle(NODE_A);
    expect(g.loginRequired).toEqual([NODE_A]);

    const before = g.reconnected.length;
    g.guard.resume();
    expect(g.reconnected).toHaveLength(before + 1);

    // 计数倒回起点：下一次 4401 又从「按瞬时处理」开始。
    await g.guard.handle(NODE_A);
    g.advance(1_000);
    expect(g.reconnected).toHaveLength(before + 2);
  });

  test('resume 不会给没在恢复中的 node 平白拉一次连接', () => {
    const g = harness();
    g.guard.resume();
    expect(g.reconnected).toEqual([]);
  });

  test('计数只在窗口内累计：隔了一个窗口再来算新的一轮', async () => {
    const g = harness({ maxTransient: 1, windowMs: 60_000 });
    await g.guard.handle(NODE_A);
    g.advance(1_000);
    g.setNow(1_000_000);
    await g.guard.handle(NODE_A);
    expect(g.loginRequired).toEqual([]);
    g.advance(1_000);
    expect(g.reconnected).toEqual([NODE_A, NODE_A]);
  });
});

describe('探测判定要重新登录之后的静默重登', () => {
  test('重登成功即重连', async () => {
    const g = harness({
      probe: () => Promise.resolve('login-required'),
      relogin: () => Promise.resolve('recovered'),
    });
    await g.guard.handle(NODE_A);
    expect(g.relogins).toEqual([NODE_A]);
    expect(g.loginRequired).toEqual([]);
    g.advance(1_000);
    expect(g.reconnected).toEqual([NODE_A]);
  });

  test('这一轮已经重登过（skipped）：照样重连，但计入次数', async () => {
    const g = harness({
      probe: () => Promise.resolve('login-required'),
      relogin: () => Promise.resolve('skipped'),
      maxTransient: 2,
    });
    await g.guard.handle(NODE_A);
    expect(g.loggedOut).toEqual([]);
    g.advance(1_000);
    expect(g.reconnected).toEqual([NODE_A]);

    await g.guard.handle(NODE_A);
    expect(g.loggedOut).toEqual([]);
    g.advance(2_000);
    expect(g.reconnected).toHaveLength(2);

    // 第三次越过上限：停掉快速重试并派事件；但这一轮**登过一次**，没有证据说会话不能用，
    // 所以不翻登录态。
    await g.guard.handle(NODE_A);
    expect(g.loggedOut).toEqual([]);
    expect(g.loginRequired).toEqual([NODE_A]);
  });

  test('重登失败：这一档才标未登录（界面给出登录入口）并派事件', async () => {
    const g = harness({
      probe: () => Promise.resolve('login-required'),
      relogin: () => Promise.resolve('failed'),
    });
    await g.guard.handle(NODE_A);
    expect(g.loginRequired).toEqual([NODE_A]);
    expect(g.loggedOut).toEqual([NODE_A]);
  });

  test('重登实现自己抛异常等同失败', async () => {
    const g = harness({
      probe: () => Promise.resolve('login-required'),
      relogin: () => Promise.reject(new Error('chunk failed')),
    });
    await g.guard.handle(NODE_A);
    expect(g.loginRequired).toEqual([NODE_A]);
  });

  test('宿主没接重登实现时直接判定', async () => {
    const g = harness({ probe: () => Promise.resolve('login-required') });
    await g.guard.handle(NODE_A);
    expect(g.loginRequired).toEqual([NODE_A]);
    expect(g.loggedOut).toEqual([NODE_A]);
  });
});

describe('探测打不通', () => {
  test('只重连，不动登录态', async () => {
    const g = harness({ probe: () => Promise.resolve('unreachable') });
    await g.guard.handle(NODE_A);
    g.advance(1_000);
    expect(g.loginRequired).toEqual([]);
    expect(g.reconnected).toEqual([NODE_A]);
  });

  test('探测自身抛异常按不可达处理', async () => {
    const g = harness({ probe: () => Promise.reject(new Error('offline')) });
    await g.guard.handle(NODE_A);
    g.advance(1_000);
    expect(g.loginRequired).toEqual([]);
    expect(g.reconnected).toEqual([NODE_A]);
  });

  test('不可达不计入次数上限', async () => {
    const g = harness({ probe: () => Promise.resolve('unreachable'), maxTransient: 1 });
    for (let i = 0; i < 5; i++) {
      await g.guard.handle(NODE_A);
      g.advance(60_000);
    }
    expect(g.loginRequired).toEqual([]);
    expect(g.loggedOut).toEqual([]);
    expect(g.reconnected).toHaveLength(5);
  });
});

describe('并发与回收', () => {
  test('同一 node 的恢复在途时不重复探测', async () => {
    let release: (value: NodeSessionProbe) => void = () => undefined;
    const g = harness({
      probe: () =>
        new Promise<NodeSessionProbe>((resolve) => {
          release = resolve;
        }),
    });
    const first = g.guard.handle(NODE_A);
    await g.guard.handle(NODE_A);
    expect(g.probes).toEqual([NODE_A]);
    release('ok');
    await first;
    g.advance(1_000);
    expect(g.reconnected).toEqual([NODE_A]);
  });

  test('探测在途时 forget：落定后不再排重连（运行时已经回收）', async () => {
    let release: (value: NodeSessionProbe) => void = () => undefined;
    const g = harness({
      probe: () =>
        new Promise<NodeSessionProbe>((resolve) => {
          release = resolve;
        }),
    });
    const pending = g.guard.handle(NODE_A);
    g.guard.forget(NODE_A);
    release('ok');
    await pending;

    expect(g.delays).toEqual([]);
    g.advance(60_000);
    expect(g.reconnected).toEqual([]);
  });

  test('forget 撤掉待发的重连', async () => {
    const g = harness();
    await g.guard.handle(NODE_A);
    g.guard.forget(NODE_A);
    g.advance(60_000);
    expect(g.reconnected).toEqual([]);
  });

  test('dispose 撤掉全部待发重连', async () => {
    const g = harness();
    await g.guard.handle(NODE_A);
    g.guard.dispose();
    g.advance(60_000);
    expect(g.reconnected).toEqual([]);
  });
});
