import { beforeEach, describe, expect, test } from 'bun:test';
import { NodeSessionGuard, type NodeSessionProbe } from './node-session-guard';

const NODE_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';

interface Harness {
  guard: NodeSessionGuard;
  reconnected: string[];
  loginRequired: string[];
  relogins: string[];
  probes: string[];
  advance: (ms: number) => void;
  setNow: (at: number) => void;
}

interface HarnessOptions {
  probe?: (nodeId: string) => Promise<NodeSessionProbe>;
  relogin?: (nodeId: string) => Promise<boolean>;
  maxTransient?: number;
  windowMs?: number;
}

function harness(options: HarnessOptions = {}): Harness {
  const reconnected: string[] = [];
  const loginRequired: string[] = [];
  const relogins: string[] = [];
  const probes: string[] = [];
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
            return options.relogin!(nodeId);
          },
        }
      : {}),
    reconnect: (nodeId) => reconnected.push(nodeId),
    onLoginRequired: (nodeId) => loginRequired.push(nodeId),
    schedule: (fn, ms) => {
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
    relogins,
    probes,
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

  test('连续 N 次「探测成功但仍 4401」之后退回「需要登录」', async () => {
    const g = harness({ maxTransient: 2 });
    await g.guard.handle(NODE_A);
    g.advance(1_000);
    await g.guard.handle(NODE_A);
    g.advance(2_000);
    expect(g.loginRequired).toEqual([]);
    await g.guard.handle(NODE_A);
    expect(g.loginRequired).toEqual([NODE_A]);
    // 退回结论之后不再排重连。
    g.advance(60_000);
    expect(g.reconnected).toHaveLength(2);
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

  test('探测回 NODE_LOGIN_REQUIRED：静默重登成功即重连', async () => {
    const g = harness({
      probe: () => Promise.resolve('login-required'),
      relogin: () => Promise.resolve(true),
    });
    await g.guard.handle(NODE_A);
    expect(g.relogins).toEqual([NODE_A]);
    expect(g.loginRequired).toEqual([]);
    g.advance(1_000);
    expect(g.reconnected).toEqual([NODE_A]);
  });

  test('重登失败才退回「需要登录」', async () => {
    const g = harness({
      probe: () => Promise.resolve('login-required'),
      relogin: () => Promise.resolve(false),
    });
    await g.guard.handle(NODE_A);
    expect(g.loginRequired).toEqual([NODE_A]);
    g.advance(60_000);
    expect(g.reconnected).toEqual([]);
  });

  test('重登实现自己抛异常等同失败', async () => {
    const g = harness({
      probe: () => Promise.resolve('login-required'),
      relogin: () => Promise.reject(new Error('chunk failed')),
    });
    await g.guard.handle(NODE_A);
    expect(g.loginRequired).toEqual([NODE_A]);
  });

  test('宿主没接重登实现时，login-required 直接退回「需要登录」', async () => {
    const g = harness({ probe: () => Promise.resolve('login-required') });
    await g.guard.handle(NODE_A);
    expect(g.loginRequired).toEqual([NODE_A]);
  });

  test('探测打不通（不可达 / 网络错误）：只重连，不动登录态', async () => {
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

  test('不可达不计入「探测成功」的次数上限', async () => {
    const g = harness({ probe: () => Promise.resolve('unreachable'), maxTransient: 1 });
    for (let i = 0; i < 5; i++) {
      await g.guard.handle(NODE_A);
      g.advance(60_000);
    }
    expect(g.loginRequired).toEqual([]);
    expect(g.reconnected).toHaveLength(5);
  });

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

  test('forget 撤掉待发的重连', async () => {
    await h.guard.handle(NODE_A);
    h.guard.forget(NODE_A);
    h.advance(60_000);
    expect(h.reconnected).toEqual([]);
  });

  test('dispose 撤掉全部待发重连', async () => {
    await h.guard.handle(NODE_A);
    h.guard.dispose();
    h.advance(60_000);
    expect(h.reconnected).toEqual([]);
  });
});
