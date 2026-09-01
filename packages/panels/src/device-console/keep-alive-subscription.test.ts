// 保活池 → wire 订阅集合的端到端接线：隐藏实例在宽限期内照常订阅，期满置冷只撤订阅贡献，
// sink 注册与终端实例都留着。bun test 无 DOM，这里按 terminal-stage 的提交顺序手工驱动
// 每个 Terminal 实例的两个 effect（sink 注册无条件、mountPane 受 subscribe 门控），
// 其余（池演进、冷却计时）都用生产代码本体。

import { afterEach, describe, expect, jest, test } from 'bun:test';
import { createAppRuntime } from '@tmex/stores';
import { installWindowStorage } from '@tmex/stores/test-utils';
import { type GatewayTransportCommand, createSharedGatewayTransport } from '@tmex/ws-client';
import type { PaneSink } from '@tmex/ws-client/pane-sink-registry';
import {
  type KeepAlivePool,
  createKeepAliveColdScheduler,
  createKeepAlivePool,
  isKeepAlivePaneCold,
  keepAlivePaneIds,
  markKeepAlivePaneCold,
  retainKeepAlivePane,
} from './terminal-keep-alive';

installWindowStorage();

const GRACE_MS = 1000;

let harnessSeq = 0;

function createStageHarness() {
  const commands: GatewayTransportCommand[] = [];
  const transport = createSharedGatewayTransport({
    initialState: 'READY',
    onCommand: (command) => {
      commands.push(command);
    },
  });
  const runtime = createAppRuntime({
    transport,
    storagePrefix: `keep-alive-subscription-${harnessSeq++}:`,
  });
  const tmux = runtime.stores.tmux.getState();
  tmux.ensureSocketConnected();
  commands.length = 0;

  let pool = createKeepAlivePool();
  const mounted = new Map<string, () => void>();
  const sinks = new Map<string, () => void>();
  const resets = new Map<string, string[]>();

  function paneSink(paneId: string): PaneSink {
    const seen: string[] = [];
    resets.set(paneId, seen);
    return {
      onReset: (origin) => seen.push(origin),
      onApplyHistory: () => {},
      onOutput: () => {},
    };
  }

  const scheduler = createKeepAliveColdScheduler((paneId) => {
    pool = markKeepAlivePaneCold(pool, paneId);
    commit();
  }, GRACE_MS);

  function commit(): void {
    const deviceId = pool.deviceId ?? '';
    const live = new Set(keepAlivePaneIds(pool));

    for (const [paneId, unregister] of [...sinks]) {
      if (live.has(paneId)) continue;
      unregister();
      sinks.delete(paneId);
    }
    for (const [paneId, release] of [...mounted]) {
      if (live.has(paneId) && !isKeepAlivePaneCold(pool, paneId)) continue;
      release();
      mounted.delete(paneId);
    }
    for (const paneId of live) {
      if (!sinks.has(paneId)) {
        sinks.set(paneId, runtime.paneSinks.registerPaneSink(deviceId, paneId, paneSink(paneId)));
      }
      if (isKeepAlivePaneCold(pool, paneId) || mounted.has(paneId)) continue;
      mounted.set(paneId, tmux.mountPane(deviceId, paneId));
    }

    scheduler.sync(pool);
  }

  return {
    show(paneId: string, deviceId = 'device-a'): void {
      pool = retainKeepAlivePane(pool, deviceId, paneId);
      commit();
    },
    subscribeManually(paneIds: string[]): void {
      tmux.subscribePanes('device-a', paneIds);
    },
    unmount(): void {
      scheduler.dispose();
      for (const release of mounted.values()) release();
      mounted.clear();
      for (const unregister of sinks.values()) unregister();
      sinks.clear();
    },
    pool(): KeepAlivePool {
      return pool;
    },
    /** sink 是否仍注册：置冷的 pane 收到 reset 就证明注册表没有把它当成「无 sink」缓冲 */
    sinkReceives(paneId: string): boolean {
      runtime.paneSinks.dispatchPaneReset('device-a', paneId, 'select');
      return (resets.get(paneId)?.length ?? 0) > 0;
    },
    lastSubscriptionSet(): string[] | undefined {
      return commands
        .filter(
          (
            command
          ): command is Extract<GatewayTransportCommand, { type: 'set-pane-subscriptions' }> =>
            command.type === 'set-pane-subscriptions'
        )
        .at(-1)?.paneIds;
    },
    dispose(): void {
      runtime.dispose();
      transport.dispose();
    },
  };
}

describe('keep-alive wire subscriptions', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('a hidden pane stays subscribed for the grace period, then drops out of the set', () => {
    jest.useFakeTimers();
    const stage = createStageHarness();

    stage.show('%1');
    stage.show('%2');
    expect(stage.lastSubscriptionSet()).toEqual(['%1', '%2']);

    jest.advanceTimersByTime(GRACE_MS - 1);
    expect(stage.lastSubscriptionSet()).toEqual(['%1', '%2']);

    jest.advanceTimersByTime(1);
    expect(stage.lastSubscriptionSet()).toEqual(['%2']);
    // 实例与 sink 都还挂着，注册表不会为它开始缓冲
    expect(keepAlivePaneIds(stage.pool())).toEqual(['%2', '%1']);
    expect(stage.sinkReceives('%1')).toBe(true);

    stage.unmount();
    stage.dispose();
  });

  test('re-showing a cold pane resubscribes it and revokes its warm eligibility', () => {
    jest.useFakeTimers();
    const stage = createStageHarness();

    stage.show('%1');
    stage.show('%2');
    jest.advanceTimersByTime(GRACE_MS);
    expect(stage.lastSubscriptionSet()).toEqual(['%2']);

    stage.show('%1');
    expect(stage.lastSubscriptionSet()).toEqual(['%1', '%2']);
    // 退订期间的输出补不回来：必须冷 select（wantHistory:true）
    expect(stage.pool().visibleIsWarm).toBe(false);
    expect(isKeepAlivePaneCold(stage.pool(), '%1')).toBe(false);

    stage.unmount();
    stage.dispose();
  });

  test('a re-show inside the grace period keeps the warm switch', () => {
    jest.useFakeTimers();
    const stage = createStageHarness();

    stage.show('%1');
    stage.show('%2');
    jest.advanceTimersByTime(GRACE_MS - 1);
    stage.show('%1');

    expect(stage.pool().visibleIsWarm).toBe(true);
    expect(stage.lastSubscriptionSet()).toEqual(['%1', '%2']);

    stage.unmount();
    stage.dispose();
  });

  test('a manual subscription keeps a cold pane on the wire', () => {
    jest.useFakeTimers();
    const stage = createStageHarness();

    stage.show('%1');
    stage.show('%2');
    stage.subscribeManually(['%1']);
    jest.advanceTimersByTime(GRACE_MS);

    // 置冷只撤走「挂载实例」这一份贡献，手动订阅（别的面板 / 另一处消费者）不受影响
    expect(stage.lastSubscriptionSet()).toEqual(['%1', '%2']);

    stage.unmount();
    stage.dispose();
  });

  test('unmounting the stage clears the countdown and every subscription', () => {
    jest.useFakeTimers();
    const stage = createStageHarness();

    stage.show('%1');
    stage.show('%2');
    stage.unmount();
    jest.advanceTimersByTime(GRACE_MS * 5);

    expect(stage.lastSubscriptionSet()).toEqual([]);

    stage.dispose();
  });
});
