// wire 订阅集合的两个来源（手动订阅 ∪ 挂载中 pane）互不干扰，
// 且 sink 注册与订阅贡献是两条独立生命周期——保活池里置冷的隐藏实例正是靠这一点：
// 撤订阅贡献后 sink 仍在，注册表因此没有理由开始缓冲。

import { describe, expect, test } from 'bun:test';
import { type GatewayTransportCommand, createSharedGatewayTransport } from '@vibeterm/ws-client';
import type { PaneSink } from '@vibeterm/ws-client/pane-sink-registry';
import { createAppRuntime } from './app-runtime';
import {
  CANONICAL_MAX_HISTORY_PAGE_BYTES,
  HISTORY_PAGE_BYTE_LIMIT,
  historyPageByteLimit,
} from './pane-subscriptions';
import { installWindowStorage } from './test-utils';

installWindowStorage();

let harnessSeq = 0;

function createHarness() {
  const commands: GatewayTransportCommand[] = [];
  const transport = createSharedGatewayTransport({
    initialState: 'READY',
    onCommand: (command) => {
      commands.push(command);
    },
  });
  const runtime = createAppRuntime({
    transport,
    storagePrefix: `pane-subscriptions-${harnessSeq++}:`,
  });
  runtime.stores.tmux.getState().ensureSocketConnected();
  commands.length = 0;

  return {
    runtime,
    transport,
    commands,
    subscriptionSets(): string[][] {
      return commands
        .filter(
          (
            command
          ): command is Extract<GatewayTransportCommand, { type: 'set-pane-subscriptions' }> =>
            command.type === 'set-pane-subscriptions'
        )
        .map((command) => command.paneIds);
    },
    dispose(): void {
      runtime.dispose();
      transport.dispose();
    },
  };
}

function recordingSink(): { sink: PaneSink; rebases: string[] } {
  const rebases: string[] = [];
  return {
    rebases,
    sink: {
      onOutput: () => {},
      onRebase: (reason) => rebases.push(reason),
    },
  };
}

describe('history page byte limit', () => {
  test('未知或低 RTT 保持 256 KiB', () => {
    expect(historyPageByteLimit(null)).toBe(HISTORY_PAGE_BYTE_LIMIT);
    expect(historyPageByteLimit(undefined)).toBe(HISTORY_PAGE_BYTE_LIMIT);
    expect(historyPageByteLimit(50)).toBe(HISTORY_PAGE_BYTE_LIMIT);
    expect(historyPageByteLimit(200)).toBe(HISTORY_PAGE_BYTE_LIMIT);
  });

  test('800 ms RTT 用满 cap，减少翻页往返', () => {
    expect(historyPageByteLimit(800)).toBe(CANONICAL_MAX_HISTORY_PAGE_BYTES);
    expect(historyPageByteLimit(2_000)).toBe(CANONICAL_MAX_HISTORY_PAGE_BYTES);
  });

  test('200–800 ms 之间线性插值', () => {
    const mid = historyPageByteLimit(500);
    expect(mid).toBeGreaterThan(HISTORY_PAGE_BYTE_LIMIT);
    expect(mid).toBeLessThan(CANONICAL_MAX_HISTORY_PAGE_BYTES);
  });

  test('高 RTT 时 request-pane-history 带上放大后的 byteLimit', () => {
    const harness = createHarness();
    harness.transport.publish({ type: 'latency', latencyMs: 800, rawMs: 820 });
    harness.runtime.stores.tmux.getState().fetchPaneHistory('device-a', '%1', null);
    const history = harness.commands.filter(
      (command): command is Extract<GatewayTransportCommand, { type: 'request-pane-history' }> =>
        command.type === 'request-pane-history'
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.byteLimit).toBe(CANONICAL_MAX_HISTORY_PAGE_BYTES);
    harness.dispose();
  });

  test('无 RTT 样本时仍是 256 KiB，且一次只发一页', () => {
    const harness = createHarness();
    const tmux = harness.runtime.stores.tmux.getState();
    tmux.fetchPaneHistory('device-a', '%1', null);
    tmux.fetchPaneHistory('device-a', '%1', {
      paneEpoch: new Uint8Array(16),
      historyEpoch: new Uint8Array(16),
      beforeLine: 100,
    });
    const history = harness.commands.filter((command) => command.type === 'request-pane-history');
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ byteLimit: HISTORY_PAGE_BYTE_LIMIT });
    harness.dispose();
  });
});

describe('pane subscription set', () => {
  test('withdrawing the mounted contribution removes the pane from the payload', () => {
    const harness = createHarness();
    const tmux = harness.runtime.stores.tmux.getState();

    const releaseVisible = tmux.mountPane('device-a', '%1');
    const releaseHidden = tmux.mountPane('device-a', '%2');
    // 隐藏实例过了宽限期：只撤订阅贡献
    releaseHidden();

    expect(harness.subscriptionSets()).toEqual([['%1'], ['%1', '%2'], ['%1']]);

    releaseVisible();
    harness.dispose();
  });

  test('a manual subscription keeps a cold pane subscribed', () => {
    const harness = createHarness();
    const tmux = harness.runtime.stores.tmux.getState();

    tmux.subscribePanes('device-a', ['%2']);
    const releaseHidden = tmux.mountPane('device-a', '%2');
    releaseHidden();

    // 撤掉的只是挂载贡献，手动订阅仍然把它留在集合里
    expect(harness.subscriptionSets().at(-1)).toEqual(['%2']);

    harness.dispose();
  });

  test('re-showing a cold pane puts it back into the payload', () => {
    const harness = createHarness();
    const tmux = harness.runtime.stores.tmux.getState();

    tmux.mountPane('device-a', '%1');
    const releaseHidden = tmux.mountPane('device-a', '%2');
    releaseHidden();
    tmux.mountPane('device-a', '%2');

    expect(harness.subscriptionSets().at(-1)).toEqual(['%1', '%2']);

    harness.dispose();
  });

  test('sink registration is independent of the subscription contribution', () => {
    const harness = createHarness();
    const tmux = harness.runtime.stores.tmux.getState();
    const { sink, rebases } = recordingSink();

    const unregister = harness.runtime.paneSinks.registerPaneSink('device-a', '%2', sink);
    // 注册 sink 本身不下发订阅
    expect(harness.subscriptionSets()).toEqual([]);

    const releaseHidden = tmux.mountPane('device-a', '%2');
    releaseHidden();

    // 置冷后 sink 仍在注册表里，注册表不会为它开始缓冲：投递直达 sink 而不是进 pending
    harness.runtime.paneSinks.dispatchPaneRebase('device-a', '%2', 'pane_gap');
    expect(rebases).toEqual(['pane_gap']);

    unregister();
    harness.dispose();
  });
});
