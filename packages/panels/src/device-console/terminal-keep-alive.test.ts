// 单屏保活池：MRU 淘汰、可见实例排在最前、设备切换清空、流中断取消 warm 资格，
// 以及「池归组件实例所有 + 提交阶段发布」在 StrictMode 双调用下仍然成立。

import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import {
  KEEP_ALIVE_COLD_DELAY_MS,
  KEEP_ALIVE_LIMIT,
  type KeepAlivePool,
  applyKeepAliveStreamState,
  createKeepAliveColdScheduler,
  createKeepAlivePool,
  isKeepAlivePaneCold,
  isKeepAliveRetained,
  isKeepAliveWarmTarget,
  isRetainedPane,
  isWarmSelectTarget,
  keepAliveCoolingPaneIds,
  keepAliveLivePaneIdsFromKey,
  keepAliveLivePaneIdsKey,
  keepAlivePaneIds,
  keepAlivePaneKey,
  markKeepAlivePaneCold,
  publishKeepAlivePool,
  resetKeepAlivePublicationForTest,
  retainKeepAlivePane,
  retainLiveKeepAlivePanes,
  unpublishKeepAlivePool,
} from './terminal-keep-alive';

describe('keep-alive pool', () => {
  test('first visit is cold, revisiting a retained pane is warm', () => {
    let pool = createKeepAlivePool();
    pool = retainKeepAlivePane(pool, 'dev-1', '%1');
    expect(pool.visibleIsWarm).toBe(false);

    pool = retainKeepAlivePane(pool, 'dev-1', '%2');
    expect(pool.visibleIsWarm).toBe(false);

    pool = retainKeepAlivePane(pool, 'dev-1', '%1');
    expect(pool.visibleIsWarm).toBe(true);
    expect(isKeepAliveWarmTarget(pool, 'dev-1', '%1')).toBe(true);
    expect(isKeepAliveWarmTarget(pool, 'dev-1', '%2')).toBe(false);
    expect(isKeepAliveRetained(pool, 'dev-1', '%2')).toBe(true);
  });

  test('retaining the visible pane again is idempotent (StrictMode double render)', () => {
    let pool = createKeepAlivePool();
    pool = retainKeepAlivePane(pool, 'dev-1', '%1');
    pool = retainKeepAlivePane(pool, 'dev-1', '%2');
    const warm = retainKeepAlivePane(pool, 'dev-1', '%1');
    expect(retainKeepAlivePane(warm, 'dev-1', '%1')).toBe(warm);
  });

  test('evicts the least recently used pane beyond the limit', () => {
    let pool = createKeepAlivePool();
    for (const paneId of ['%1', '%2', '%3']) {
      pool = retainKeepAlivePane(pool, 'dev-1', paneId);
    }
    expect(keepAlivePaneIds(pool)).toEqual(['%3', '%2', '%1']);

    pool = retainKeepAlivePane(pool, 'dev-1', '%4');
    expect(keepAlivePaneIds(pool)).toHaveLength(KEEP_ALIVE_LIMIT);
    expect(isKeepAliveRetained(pool, 'dev-1', '%1')).toBe(false);
    expect(keepAlivePaneIds(pool)).toEqual(['%4', '%3', '%2']);
  });

  test('the visible pane is always rendered first', () => {
    let pool = createKeepAlivePool();
    for (const paneId of ['%1', '%2', '%3']) {
      pool = retainKeepAlivePane(pool, 'dev-1', paneId);
    }
    pool = retainKeepAlivePane(pool, 'dev-1', '%1');
    expect(keepAlivePaneIds(pool)[0]).toBe('%1');
    expect(pool.visibleIsWarm).toBe(true);
  });

  test('switching device drops every retained pane of the previous one', () => {
    let pool = createKeepAlivePool();
    pool = retainKeepAlivePane(pool, 'dev-1', '%1');
    pool = retainKeepAlivePane(pool, 'dev-1', '%2');

    pool = retainKeepAlivePane(pool, 'dev-2', '%1');
    expect(keepAlivePaneIds(pool)).toEqual(['%1']);
    expect(pool.visibleIsWarm).toBe(false);
    expect(isKeepAliveWarmTarget(pool, 'dev-1', '%1')).toBe(false);
  });
});

describe('stream interruption', () => {
  function warmPool(): KeepAlivePool {
    let pool = createKeepAlivePool();
    pool = retainKeepAlivePane(pool, 'dev-1', '%1');
    pool = retainKeepAlivePane(pool, 'dev-1', '%2');
    return retainKeepAlivePane(pool, 'dev-1', '%1');
  }

  test('entering an interruption drops hidden panes and revokes warm eligibility', () => {
    const pool = applyKeepAliveStreamState(warmPool(), true);

    expect(keepAlivePaneIds(pool)).toEqual(['%1']);
    // 可见实例也错过了中断期间的输出：不能再当 warm 目标
    expect(isKeepAliveWarmTarget(pool, 'dev-1', '%1')).toBe(false);
  });

  test('the visible terminal stays mounted while the stream is down', () => {
    const before = warmPool();
    const during = applyKeepAliveStreamState(before, true);
    // 断线期间保持挂载，用户还能看清已有内容（key 不变 = 不重挂）
    expect(keepAlivePaneKey(during, '%1')).toBe(keepAlivePaneKey(before, '%1'));
  });

  test('resuming keeps the visible terminal mounted and only revokes warm', () => {
    const interrupted = applyKeepAliveStreamState(warmPool(), true);
    const resumed = applyKeepAliveStreamState(interrupted, false);

    // 换 key 会在冷 history 到达前把可见终端卸掉，必然白闪一屏；
    // 内容由缺口账本保证的那次冷 select 用 reset + history 原子替换
    expect(keepAlivePaneKey(resumed, '%1')).toBe(keepAlivePaneKey(interrupted, '%1'));
    expect(isKeepAliveWarmTarget(resumed, 'dev-1', '%1')).toBe(false);
  });

  test('repeating the same stream state is a no-op', () => {
    const pool = applyKeepAliveStreamState(warmPool(), true);
    expect(applyKeepAliveStreamState(pool, true)).toBe(pool);
  });
});

describe('snapshot pane removal', () => {
  test('metadata-only snapshot changes keep the live pane subscription key stable', () => {
    const windows = [
      {
        id: '@1',
        name: 'shell',
        index: 0,
        active: true,
        panes: [
          { id: '%2', windowId: '@1', index: 1, active: false, width: 80, height: 24 },
          { id: '%1', windowId: '@1', index: 0, active: true, width: 80, height: 24 },
        ],
      },
    ];
    const before = keepAliveLivePaneIdsKey(windows);
    const after = keepAliveLivePaneIdsKey([
      {
        ...windows[0],
        name: 'renamed',
        panes: windows[0].panes.map((pane) => ({
          ...pane,
          title: `title-${pane.id}`,
          currentPath: '/tmp',
          currentCommand: 'bun',
        })),
      },
    ]);

    expect(after).toBe(before);
    expect([...keepAliveLivePaneIdsFromKey(after)!]).toEqual(['%1', '%2']);
  });

  test('a hidden pane removed from the snapshot is unmounted and re-boots cold', () => {
    let pool = createKeepAlivePool();
    pool = retainKeepAlivePane(pool, 'dev-1', '%1');
    pool = retainKeepAlivePane(pool, 'dev-1', '%2');
    const before = pool;

    pool = retainLiveKeepAlivePanes(pool, new Set(['%2']));

    expect(keepAlivePaneIds(pool)).toEqual(['%2']);

    // 同一个 id 再出现（tmux 复用）：不在池里 ⇒ 冷；且 key 与旧实例不同
    pool = retainKeepAlivePane(pool, 'dev-1', '%1');
    expect(pool.visibleIsWarm).toBe(false);
    expect(keepAlivePaneKey(pool, '%1')).not.toBe(keepAlivePaneKey(before, '%1'));
  });

  test('removing a hidden pane never disturbs the visible one', () => {
    let pool = createKeepAlivePool();
    pool = retainKeepAlivePane(pool, 'dev-1', '%1');
    pool = retainKeepAlivePane(pool, 'dev-1', '%2');
    const visibleKey = keepAlivePaneKey(pool, '%2');

    pool = retainLiveKeepAlivePanes(pool, new Set(['%2']));

    // 可见实例重挂的话，路由身份没变、select 会被去重跳过，legacy 链路又不会自己拉首屏 ⇒ 空白
    expect(keepAlivePaneKey(pool, '%2')).toBe(visibleKey);
  });

  test('the visible pane is never pruned (the snapshot may just be behind)', () => {
    let pool = createKeepAlivePool();
    pool = retainKeepAlivePane(pool, 'dev-1', '%1');

    pool = retainLiveKeepAlivePanes(pool, new Set<string>());

    expect(keepAlivePaneIds(pool)).toEqual(['%1']);
  });

  test('a snapshot that still holds every retained pane changes nothing', () => {
    let pool = createKeepAlivePool();
    pool = retainKeepAlivePane(pool, 'dev-1', '%1');
    pool = retainKeepAlivePane(pool, 'dev-1', '%2');

    expect(retainLiveKeepAlivePanes(pool, new Set(['%1', '%2']))).toBe(pool);
  });
});

// 隐藏实例的宽限期：期内保持订阅（切回即时 warm），期满置冷退订但实例与 sink 不动。
describe('cold subscription grace period', () => {
  function hiddenPool(): KeepAlivePool {
    let pool = createKeepAlivePool();
    pool = retainKeepAlivePane(pool, 'dev-1', '%1');
    return retainKeepAlivePane(pool, 'dev-1', '%2');
  }

  test('a freshly hidden pane keeps its subscription and stays warm', () => {
    const pool = hiddenPool();
    expect(isKeepAlivePaneCold(pool, '%1')).toBe(false);
    expect(keepAliveCoolingPaneIds(pool)).toEqual(['%1']);
    expect(retainKeepAlivePane(pool, 'dev-1', '%1').visibleIsWarm).toBe(true);
  });

  test('going cold withdraws the subscription while the instance stays mounted', () => {
    const pool = markKeepAlivePaneCold(hiddenPool(), '%1');
    expect(isKeepAlivePaneCold(pool, '%1')).toBe(true);
    expect(keepAlivePaneIds(pool)).toEqual(['%2', '%1']);
    // 已置冷的不再计时；key 不变 = Ghostty 实例与 sink 都还挂着
    expect(keepAliveCoolingPaneIds(pool)).toEqual([]);
    expect(keepAlivePaneKey(pool, '%1')).toBe(keepAlivePaneKey(hiddenPool(), '%1'));
  });

  test('re-showing a cold pane forces a cold select and resubscribes it', () => {
    let pool = markKeepAlivePaneCold(hiddenPool(), '%1');
    pool = retainKeepAlivePane(pool, 'dev-1', '%1');
    expect(pool.visibleIsWarm).toBe(false);
    expect(isKeepAlivePaneCold(pool, '%1')).toBe(false);
    expect(keepAliveCoolingPaneIds(pool)).toEqual(['%2']);
  });

  test('the visible pane and unknown panes can never be marked cold', () => {
    const pool = hiddenPool();
    expect(markKeepAlivePaneCold(pool, '%2')).toBe(pool);
    expect(markKeepAlivePaneCold(pool, '%9')).toBe(pool);
    const cold = markKeepAlivePaneCold(pool, '%1');
    expect(markKeepAlivePaneCold(cold, '%1')).toBe(cold);
  });

  test('a pane deleted while cold leaves no state behind', () => {
    let pool = markKeepAlivePaneCold(hiddenPool(), '%1');
    pool = retainLiveKeepAlivePanes(pool, new Set(['%2']));
    expect(pool.coldPanes).toEqual([]);
    expect(keepAlivePaneIds(pool)).toEqual(['%2']);
  });

  test('an MRU eviction drops the cold entry with the pane', () => {
    let pool = createKeepAlivePool(2);
    pool = retainKeepAlivePane(pool, 'dev-1', '%1');
    pool = retainKeepAlivePane(pool, 'dev-1', '%2');
    pool = markKeepAlivePaneCold(pool, '%1');
    pool = retainKeepAlivePane(pool, 'dev-1', '%3');

    expect(keepAlivePaneIds(pool)).toEqual(['%3', '%2']);
    expect(pool.coldPanes).toEqual([]);
  });

  test('a stream interruption clears cold state along with the hidden panes', () => {
    const pool = applyKeepAliveStreamState(markKeepAlivePaneCold(hiddenPool(), '%1'), true);
    expect(pool.coldPanes).toEqual([]);
    expect(keepAlivePaneIds(pool)).toEqual(['%2']);
  });
});

describe('cold scheduler', () => {
  function hiddenPool(): KeepAlivePool {
    let pool = createKeepAlivePool();
    pool = retainKeepAlivePane(pool, 'dev-1', '%1');
    return retainKeepAlivePane(pool, 'dev-1', '%2');
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  test('the default grace period is a minute', () => {
    expect(KEEP_ALIVE_COLD_DELAY_MS).toBe(60_000);
  });

  test('a hidden pane goes cold only once the grace period elapses', () => {
    jest.useFakeTimers();
    const cold: string[] = [];
    const scheduler = createKeepAliveColdScheduler((paneId) => cold.push(paneId));

    scheduler.sync(hiddenPool());
    jest.advanceTimersByTime(KEEP_ALIVE_COLD_DELAY_MS - 1);
    expect(cold).toEqual([]);

    jest.advanceTimersByTime(1);
    expect(cold).toEqual(['%1']);
    scheduler.dispose();
  });

  test('repeated syncs do not restart the countdown', () => {
    jest.useFakeTimers();
    const cold: string[] = [];
    const scheduler = createKeepAliveColdScheduler((paneId) => cold.push(paneId), 1000);
    const pool = hiddenPool();

    scheduler.sync(pool);
    jest.advanceTimersByTime(600);
    scheduler.sync(pool);
    jest.advanceTimersByTime(400);

    expect(cold).toEqual(['%1']);
    scheduler.dispose();
  });

  test('re-showing within the grace period cancels the countdown', () => {
    jest.useFakeTimers();
    const cold: string[] = [];
    const scheduler = createKeepAliveColdScheduler((paneId) => cold.push(paneId), 1000);

    let pool = hiddenPool();
    scheduler.sync(pool);
    jest.advanceTimersByTime(600);
    pool = retainKeepAlivePane(pool, 'dev-1', '%1');
    scheduler.sync(pool);
    jest.advanceTimersByTime(1000);

    // %1 的倒计时被撤销；换成刚隐藏的 %2 自己重新计时
    expect(cold).toEqual(['%2']);
    scheduler.dispose();
  });

  test('an already cold pane is not armed again', () => {
    jest.useFakeTimers();
    const cold: string[] = [];
    const scheduler = createKeepAliveColdScheduler((paneId) => cold.push(paneId), 1000);

    scheduler.sync(markKeepAlivePaneCold(hiddenPool(), '%1'));
    jest.advanceTimersByTime(5000);

    expect(cold).toEqual([]);
    scheduler.dispose();
  });

  test('a pane removed from the pool loses its countdown', () => {
    jest.useFakeTimers();
    const cold: string[] = [];
    const scheduler = createKeepAliveColdScheduler((paneId) => cold.push(paneId), 1000);

    let pool = hiddenPool();
    scheduler.sync(pool);
    jest.advanceTimersByTime(500);
    pool = retainLiveKeepAlivePanes(pool, new Set(['%2']));
    scheduler.sync(pool);
    jest.advanceTimersByTime(1000);

    expect(cold).toEqual([]);
    scheduler.dispose();
  });

  test('switching device drops the previous countdowns', () => {
    jest.useFakeTimers();
    const cold: string[] = [];
    const scheduler = createKeepAliveColdScheduler((paneId) => cold.push(paneId), 1000);

    let pool = hiddenPool();
    scheduler.sync(pool);
    jest.advanceTimersByTime(500);
    pool = retainKeepAlivePane(pool, 'dev-2', '%1');
    scheduler.sync(pool);
    jest.advanceTimersByTime(1000);

    expect(cold).toEqual([]);
    scheduler.dispose();
  });

  test('disposing on unmount clears every pending countdown', () => {
    jest.useFakeTimers();
    const cold: string[] = [];
    const scheduler = createKeepAliveColdScheduler((paneId) => cold.push(paneId), 1000);

    scheduler.sync(hiddenPool());
    scheduler.dispose();
    jest.advanceTimersByTime(5000);

    expect(cold).toEqual([]);
  });
});

// terminal-stage 的 useOwnedKeepAlivePool 契约：render 期推进实例自己的池，
// 提交阶段（useLayoutEffect）发布快照，cleanup 按 owner 撤销。
function createStackInstance() {
  const owner = Symbol('stack');
  let pool = createKeepAlivePool();
  return {
    render(
      deviceId: string,
      paneId: string,
      streamInterrupted = false,
      livePaneIds: ReadonlySet<string> | null = null
    ): KeepAlivePool {
      pool = applyKeepAliveStreamState(pool, streamInterrupted);
      if (livePaneIds) pool = retainLiveKeepAlivePanes(pool, livePaneIds);
      pool = retainKeepAlivePane(pool, deviceId, paneId);
      return pool;
    },
    /** 冷却定时器到点：scheduler 的回调改池并触发重渲染 */
    goCold(paneId: string): KeepAlivePool {
      pool = markKeepAlivePaneCold(pool, paneId);
      return pool;
    },
    layoutSetup(): void {
      publishKeepAlivePool(owner, pool);
    },
    layoutCleanup(): void {
      unpublishKeepAlivePool(owner);
    },
    /** StrictMode 挂载：setup → cleanup → setup */
    strictModeCommit(): void {
      this.layoutSetup();
      this.layoutCleanup();
      this.layoutSetup();
    },
  };
}

describe('published pool (terminal-stage lifecycle)', () => {
  beforeEach(() => {
    resetKeepAlivePublicationForTest();
  });

  test('survives the StrictMode simulated remount and keeps panes across switches', () => {
    const stack = createStackInstance();

    stack.render('dev-1', '%1');
    stack.strictModeCommit();
    // 池归实例所有：StrictMode 的模拟 cleanup 不会把它清空
    expect(isRetainedPane('dev-1', '%1')).toBe(true);

    stack.render('dev-1', '%2');
    stack.strictModeCommit();
    expect(isRetainedPane('dev-1', '%1')).toBe(true);
    expect(isWarmSelectTarget('dev-1', '%2')).toBe(false);

    stack.render('dev-1', '%1');
    stack.strictModeCommit();
    expect(isWarmSelectTarget('dev-1', '%1')).toBe(true);
  });

  test('a late cleanup from a replaced instance does not clobber the new publication', () => {
    const previous = createStackInstance();
    previous.render('dev-1', '%1');
    previous.layoutSetup();

    const next = createStackInstance();
    next.render('dev-2', '%9');
    next.layoutSetup();

    previous.layoutCleanup();

    expect(isRetainedPane('dev-2', '%9')).toBe(true);
    expect(isRetainedPane('dev-1', '%1')).toBe(false);
  });

  test('unmounting the owning instance clears the published pool', () => {
    const stack = createStackInstance();
    stack.render('dev-1', '%1');
    stack.layoutSetup();
    stack.layoutCleanup();

    expect(isRetainedPane('dev-1', '%1')).toBe(false);
    expect(isWarmSelectTarget('dev-1', '%1')).toBe(false);
  });

  test('connected → reconnecting → reconnected leaves the visible pane cold', () => {
    const stack = createStackInstance();
    stack.render('dev-1', '%1');
    stack.render('dev-1', '%2');
    stack.render('dev-1', '%1');
    stack.strictModeCommit();
    expect(isWarmSelectTarget('dev-1', '%1')).toBe(true);

    // 自动重连：deviceConnected 仍为 true，只有 deviceReconnecting 被置起
    const during = stack.render('dev-1', '%1', true);
    stack.layoutCleanup();
    stack.layoutSetup();
    expect(isWarmSelectTarget('dev-1', '%1')).toBe(false);
    expect(isRetainedPane('dev-1', '%2')).toBe(false);

    // 恢复：可见实例继续挂着（不闪白），但仍然必须冷 select
    const after = stack.render('dev-1', '%1');
    stack.layoutCleanup();
    stack.layoutSetup();
    expect(isWarmSelectTarget('dev-1', '%1')).toBe(false);
    expect(keepAlivePaneKey(after, '%1')).toBe(keepAlivePaneKey(during, '%1'));
  });

  test('a pane that went cold while hidden is re-selected cold, then warm again', () => {
    const stack = createStackInstance();
    stack.render('dev-1', '%1');
    stack.render('dev-1', '%2');
    stack.strictModeCommit();

    // 宽限期内切回仍是 warm
    stack.render('dev-1', '%1');
    stack.strictModeCommit();
    expect(isWarmSelectTarget('dev-1', '%1')).toBe(true);

    stack.render('dev-1', '%2');
    stack.strictModeCommit();
    stack.goCold('%1');
    stack.strictModeCommit();

    // 实例还在（不重挂），但订阅已撤 ⇒ 必须冷 select 重放 history
    expect(isRetainedPane('dev-1', '%1')).toBe(true);
    stack.render('dev-1', '%1');
    stack.strictModeCommit();
    expect(isWarmSelectTarget('dev-1', '%1')).toBe(false);

    // 冷 select 后它重新订阅：再切走再切回（宽限期内）又是 warm
    stack.render('dev-1', '%2');
    stack.render('dev-1', '%1');
    stack.strictModeCommit();
    expect(isWarmSelectTarget('dev-1', '%1')).toBe(true);
  });

  test('a hidden pane deleted from the snapshot cannot be deep-linked back into warm', () => {
    const stack = createStackInstance();
    stack.render('dev-1', '%1');
    stack.render('dev-1', '%2');
    stack.strictModeCommit();
    expect(isRetainedPane('dev-1', '%1')).toBe(true);

    // 快照确认 %1 已被关闭
    stack.render('dev-1', '%2', false, new Set(['%2']));
    stack.layoutCleanup();
    stack.layoutSetup();
    expect(isRetainedPane('dev-1', '%1')).toBe(false);

    // 深链回到复用了同一 id 的 pane：只能冷启动
    stack.render('dev-1', '%1', false, new Set(['%1', '%2']));
    stack.layoutCleanup();
    stack.layoutSetup();
    expect(isWarmSelectTarget('dev-1', '%1')).toBe(false);
  });
});
