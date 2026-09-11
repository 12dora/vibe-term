// 换代接管：加载即接管、运行期只在安全时刻接管、刷新守卫只在确认恢复干净后才放开、
// 回到前台的查更新限流。全部用假的 registration / container 对象驱动。

import { describe, expect, test } from 'bun:test';
import {
  SW_SHELL_STALE_MESSAGE,
  SW_TAKEOVER_COOLDOWN_MS,
  SW_TAKEOVER_MIN_HIDDEN_MS,
  SW_UPDATE_CHECK_THROTTLE_MS,
  type SwUpdateDeps,
  type SwUpdateWorkerLike,
  createSwUpdateController,
  isShellStaleMessage,
} from './sw-update';

function fakeWorker(state = 'installing') {
  const listeners: (() => void)[] = [];
  const worker = {
    state,
    addEventListener: (_type: 'statechange', listener: () => void) => {
      listeners.push(listener);
    },
    removeEventListener: (_type: 'statechange', listener: () => void) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  return {
    worker: worker as SwUpdateWorkerLike,
    /** 模拟 statechange：先改状态再广播，和浏览器一致 */
    transition(next: string) {
      worker.state = next;
      for (const listener of [...listeners]) listener();
    },
    get listenerCount() {
      return listeners.length;
    },
  };
}

function harness(options: { waiting?: boolean; controlled?: boolean; guard?: string | null } = {}) {
  const state = {
    waiting: options.waiting ?? false,
    installing: null as SwUpdateWorkerLike | null,
    controlled: options.controlled ?? true,
    guard: options.guard ?? null,
    activated: 0,
    reloads: 0,
    updates: 0,
    now: 1_000,
    order: [] as string[],
  };
  let updateFound: (() => void) | null = null;
  const deps: SwUpdateDeps = {
    registration: {
      get waiting() {
        return state.waiting ? { postMessage: () => undefined } : null;
      },
      get installing() {
        return state.installing;
      },
      update: async () => {
        state.updates += 1;
        state.order.push('update');
      },
      addEventListener: (_type: 'updatefound', listener: () => void) => {
        updateFound = listener;
      },
    },
    hasController: () => state.controlled,
    activate: async () => {
      state.activated += 1;
      state.order.push('activate');
      // 接管成功即等于 waiting 被激活掉
      state.waiting = false;
    },
    reload: () => {
      state.reloads += 1;
      state.order.push('reload');
    },
    now: () => state.now,
    readGuard: () => state.guard,
    writeGuard: (value) => {
      state.guard = value;
    },
  };
  return {
    state,
    controller: createSwUpdateController(deps),
    /** 模拟浏览器：有新 worker 在装 → 触发 updatefound */
    install(worker: SwUpdateWorkerLike) {
      state.installing = worker;
      updateFound?.();
    },
  };
}

describe('createSwUpdateController.start', () => {
  test('加载时已有 waiting：立刻握手接管并刷新，落下守卫', async () => {
    const h = harness({ waiting: true });
    expect(await h.controller.start()).toBe(true);
    expect(h.state.order).toEqual(['activate', 'reload']);
    expect(h.state.guard).toBe(String(h.state.now));
  });

  test('加载时没有 waiting：不刷新，并把上一次的守卫清掉', async () => {
    const h = harness({ guard: '900' });
    expect(await h.controller.start()).toBe(false);
    expect(h.state.reloads).toBe(0);
    expect(h.state.guard).toBeNull();
  });

  test('冷却期内（上次接管没生效）不再刷新，避免刷新循环', async () => {
    const h = harness({ waiting: true, guard: '900' });
    expect(await h.controller.start()).toBe(false);
    expect(h.state.reloads).toBe(0);
    expect(h.state.activated).toBe(0);
  });

  test('冷却期过了就再试一次：上一次失败不该永久挡住后面的真发版', async () => {
    const h = harness({ waiting: true, guard: '900' });
    h.state.now = 900 + SW_TAKEOVER_COOLDOWN_MS;
    expect(await h.controller.start()).toBe(true);
    expect(h.state.order).toEqual(['activate', 'reload']);
  });

  test('系统时钟被调回去（存的时刻在未来）时不当成守卫', async () => {
    const h = harness({ waiting: true, guard: String(10 ** 13) });
    expect(await h.controller.start()).toBe(true);
  });

  test('握手抛错也照常刷新', async () => {
    const h = harness({ waiting: true });
    const controller = createSwUpdateController({
      registration: {
        waiting: { postMessage: () => undefined },
        installing: null,
        update: async () => undefined,
        addEventListener: () => undefined,
      },
      hasController: () => true,
      activate: () => Promise.reject(new Error('nope')),
      reload: () => {
        h.state.reloads += 1;
      },
      now: () => 0,
      readGuard: () => null,
      writeGuard: () => undefined,
    });
    expect(await controller.start()).toBe(true);
    expect(h.state.reloads).toBe(1);
  });
});

describe('运行期装好新一代', () => {
  test('installed 且页面已被旧 SW 控制 → 排队，不立刻刷新', async () => {
    const h = harness();
    await h.controller.start();
    const w = fakeWorker();
    h.install(w.worker);
    w.transition('installed');

    expect(h.controller.pending).toBe(true);
    expect(h.state.reloads).toBe(0);
    expect(w.listenerCount).toBe(0);
  });

  test('首次安装（没有 controller）不算换代', async () => {
    const h = harness({ controlled: false });
    await h.controller.start();
    const w = fakeWorker();
    h.install(w.worker);
    w.transition('installed');

    expect(h.controller.pending).toBe(false);
  });

  test('装失败（redundant）不排队', async () => {
    const h = harness();
    await h.controller.start();
    const w = fakeWorker();
    h.install(w.worker);
    w.transition('redundant');

    expect(h.controller.pending).toBe(false);
  });

  test('排队后在安全时刻接管：握手 + 刷新', async () => {
    const h = harness();
    await h.controller.start();
    const w = fakeWorker();
    h.install(w.worker);
    w.transition('installed');

    h.controller.onHidden();
    h.state.now += SW_TAKEOVER_MIN_HIDDEN_MS;
    expect(await h.controller.onSafeMoment()).toBe(true);
    expect(h.state.order).toEqual(['activate', 'reload']);
    expect(h.controller.pending).toBe(false);
  });
});

describe('onShellStale', () => {
  test('SW 报旧壳且手上有 waiting → 排队等安全时刻', async () => {
    const h = harness();
    await h.controller.start();
    h.state.waiting = true;
    h.controller.onShellStale();

    expect(h.controller.pending).toBe(true);
    expect(h.state.reloads).toBe(0);
    h.controller.onHidden();
    h.state.now += SW_TAKEOVER_MIN_HIDDEN_MS;
    expect(await h.controller.onSafeMoment()).toBe(true);
  });

  test('没有 waiting 时只是噪声，不排队', async () => {
    const h = harness();
    await h.controller.start();
    h.controller.onShellStale();
    expect(h.controller.pending).toBe(false);
  });

  test('isShellStaleMessage 只认这一个 type', () => {
    expect(isShellStaleMessage({ type: SW_SHELL_STALE_MESSAGE })).toBe(true);
    expect(isShellStaleMessage({ type: 'vibeterm:sw-skip-waiting' })).toBe(false);
    expect(isShellStaleMessage(null)).toBe(false);
    expect(isShellStaleMessage('vibeterm:sw-shell-stale')).toBe(false);
  });
});

describe('onSafeMoment 的查更新', () => {
  test('没有待接管的换代时查一次更新，60 s 内不再查', async () => {
    const h = harness();
    await h.controller.start();

    expect(await h.controller.onSafeMoment()).toBe(false);
    expect(h.state.updates).toBe(1);

    h.state.now += SW_UPDATE_CHECK_THROTTLE_MS - 1;
    await h.controller.onSafeMoment();
    expect(h.state.updates).toBe(1);

    h.state.now += 1;
    await h.controller.onSafeMoment();
    expect(h.state.updates).toBe(2);
  });

  test('查更新抛错不外泄', async () => {
    const h = harness();
    await h.controller.start();
    const controller = createSwUpdateController({
      registration: {
        waiting: null,
        installing: null,
        update: () => Promise.reject(new Error('offline')),
        addEventListener: () => undefined,
      },
      hasController: () => true,
      activate: async () => undefined,
      reload: () => undefined,
      now: () => 0,
      readGuard: () => null,
      writeGuard: () => undefined,
    });
    expect(await controller.onSafeMoment()).toBe(false);
  });

  test('期间出现的 waiting（updatefound 没收到）也能接管', async () => {
    const h = harness();
    await h.controller.start();
    h.state.waiting = true;
    h.controller.onHidden();
    h.state.now += SW_TAKEOVER_MIN_HIDDEN_MS;

    expect(await h.controller.onSafeMoment()).toBe(true);
    expect(h.state.order).toEqual(['activate', 'reload']);
    expect(h.state.updates).toBe(0);
  });
});

describe('回到前台的门槛：在后台待够 30 s 才整页换代', () => {
  /** 排上一次换代，之后只等安全时刻 */
  async function queued() {
    const h = harness();
    await h.controller.start();
    const w = fakeWorker();
    h.install(w.worker);
    w.transition('installed');
    expect(h.controller.pending).toBe(true);
    return h;
  }

  test('切出去 5 s 就回来：不刷新，队还留着', async () => {
    const h = await queued();
    h.controller.onHidden();
    h.state.now += 5_000;

    expect(await h.controller.onSafeMoment()).toBe(false);
    expect(h.state.reloads).toBe(0);
    expect(h.controller.pending).toBe(true);
    // 也不该顺手去查更新：手上已经有装好的一代了
    expect(h.state.updates).toBe(0);
  });

  test('下一次待够 30 s 的回归照样接管', async () => {
    const h = await queued();
    h.controller.onHidden();
    h.state.now += 5_000;
    await h.controller.onSafeMoment();

    h.controller.onHidden();
    h.state.now += SW_TAKEOVER_MIN_HIDDEN_MS;
    expect(await h.controller.onSafeMoment()).toBe(true);
    expect(h.state.order).toEqual(['activate', 'reload']);
  });

  test('压根没进过后台（纯 pageshow / 焦点回来）不算回归', async () => {
    const h = await queued();
    expect(await h.controller.onSafeMoment()).toBe(false);
    expect(h.controller.pending).toBe(true);
  });

  test('bfcache 恢复（persisted）一律算回归', async () => {
    const h = await queued();
    expect(await h.controller.onSafeMoment({ persisted: true })).toBe(true);
    expect(h.state.order).toEqual(['activate', 'reload']);
  });

  test('不够格时不刷新，但下一次页面加载会立刻接管', async () => {
    const h = await queued();
    h.controller.onHidden();
    h.state.now += 1_000;
    await h.controller.onSafeMoment();
    expect(h.state.reloads).toBe(0);

    // 新一轮加载：start() 看见 waiting 就当场接管
    h.state.waiting = true;
    const reloaded = harness({ waiting: true });
    expect(await reloaded.controller.start()).toBe(true);
  });

  test('没有待接管的换代时门槛不影响查更新', async () => {
    const h = harness();
    await h.controller.start();
    expect(await h.controller.onSafeMoment()).toBe(false);
    expect(h.state.updates).toBe(1);
  });
});
