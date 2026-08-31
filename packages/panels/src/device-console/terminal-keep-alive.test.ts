// 单屏保活池：MRU 淘汰、可见实例排在最前、设备切换清空、流中断取消 warm 资格，
// 以及「池归组件实例所有 + 提交阶段发布」在 StrictMode 双调用下仍然成立。

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  KEEP_ALIVE_LIMIT,
  type KeepAlivePool,
  applyKeepAliveStreamState,
  createKeepAlivePool,
  isKeepAliveRetained,
  isKeepAliveWarmTarget,
  isRetainedPane,
  isWarmSelectTarget,
  keepAlivePaneIds,
  keepAlivePaneKey,
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

  test('resuming bumps the generation so the visible pane remounts cold', () => {
    const interrupted = applyKeepAliveStreamState(warmPool(), true);
    const resumed = applyKeepAliveStreamState(interrupted, false);

    // tmux 可能重启并复用 pane id：换代强制重挂一个空终端
    expect(resumed.generation).toBe(interrupted.generation + 1);
    expect(keepAlivePaneKey(resumed, '%1')).not.toBe(keepAlivePaneKey(interrupted, '%1'));
    expect(isKeepAliveWarmTarget(resumed, 'dev-1', '%1')).toBe(false);
  });

  test('repeating the same stream state is a no-op', () => {
    const pool = applyKeepAliveStreamState(warmPool(), true);
    expect(applyKeepAliveStreamState(pool, true)).toBe(pool);
  });
});

describe('snapshot pane removal', () => {
  test('a hidden pane removed from the snapshot is unmounted and re-boots cold', () => {
    let pool = createKeepAlivePool();
    pool = retainKeepAlivePane(pool, 'dev-1', '%1');
    pool = retainKeepAlivePane(pool, 'dev-1', '%2');
    const before = pool;

    pool = retainLiveKeepAlivePanes(pool, new Set(['%2']));

    expect(keepAlivePaneIds(pool)).toEqual(['%2']);
    expect(pool.generation).toBe(before.generation + 1);

    // 同一个 id 再出现（tmux 复用）：不在池里 ⇒ 冷；且 key 与旧实例不同
    pool = retainKeepAlivePane(pool, 'dev-1', '%1');
    expect(pool.visibleIsWarm).toBe(false);
    expect(keepAlivePaneKey(pool, '%1')).not.toBe(keepAlivePaneKey(before, '%1'));
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

    // 恢复：可见 pane 换代重挂，仍然必须冷 select
    const after = stack.render('dev-1', '%1');
    stack.layoutCleanup();
    stack.layoutSetup();
    expect(isWarmSelectTarget('dev-1', '%1')).toBe(false);
    expect(keepAlivePaneKey(after, '%1')).not.toBe(keepAlivePaneKey(during, '%1'));
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
