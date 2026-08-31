// warm select 的端到端行为，跑在**真实** SelectStateMachine 上：
// 只切 tmux 焦点不重放 history、不给活着的终端打 reset；被打断的旧事务连同它的
// 输出门控必须就地清掉（否则那个 pane 的 live 永远缓冲在孤儿门控里）；
// 缺口只有在补洞的冷 select 真正落定后才清除。

import { describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload, TmuxPane, TmuxWindow } from '@tmex/shared';
import {
  type GatewayTransportCommand,
  type GatewayTransportEvent,
  type SelectCallbacks,
  SelectStateMachine,
  type SelectTimerScheduler,
} from '@tmex/ws-client';
import type { RuntimeCore } from './runtime';
import type { SiteStore } from './site';
import { createTmuxStore } from './tmux';
import type { UIStore } from './ui';

const DEVICE = 'device-a';

function pane(id: string): TmuxPane {
  return { id, windowId: '@1', index: 0, active: true, width: 80, height: 24 };
}

function snapshotWith(paneIds: string[]): StateSnapshotPayload {
  const window: TmuxWindow = {
    id: '@1',
    name: 'shell',
    index: 0,
    active: true,
    panes: paneIds.map(pane),
  };
  return { deviceId: DEVICE, session: { id: '$1', name: 'main', windows: [window] } };
}

function createScheduler() {
  const tasks = new Map<number, () => void>();
  let nextId = 1;
  const scheduler: SelectTimerScheduler = {
    schedule: (callback) => {
      const id = nextId++;
      tasks.set(id, callback);
      return id;
    },
    cancel: (handle) => {
      tasks.delete(handle as number);
    },
  };
  return {
    scheduler,
    fireAll(): void {
      for (const [id, run] of [...tasks]) {
        tasks.delete(id);
        run();
      }
    },
  };
}

type SelectCommand = GatewayTransportCommand & { type: 'select-pane' };

function createHarness() {
  const commands: GatewayTransportCommand[] = [];
  const resets: Array<[string, string]> = [];
  const histories: Array<[string, string]> = [];
  let emit: ((event: GatewayTransportEvent) => void) | null = null;

  const timers = createScheduler();
  const machine = new SelectStateMachine(
    {},
    // maxBufferedBytes 压到极小，便于在测试里真实触发门控溢出
    {
      scheduler: timers.scheduler,
      ackTimeoutMs: 1500,
      progressTimeoutMs: 5000,
      maxBufferedBytes: 8,
    }
  );

  const core = {
    transport: {
      capabilities: { atomicScreen: false, cursorHistory: false },
      send: (command: GatewayTransportCommand) => {
        commands.push(command);
        return true;
      },
      onEvent: (handler: (event: GatewayTransportEvent) => void) => {
        emit = handler;
        return () => {
          emit = null;
        };
      },
      getState: () => 'IDLE',
      isReady: () => false,
      connect: () => {},
      hasConnectedOnce: false,
      latencyMs: null,
    },
    selectMachine: (callbacks?: SelectCallbacks) => {
      if (callbacks) machine.setCallbacks(callbacks);
      return machine;
    },
    paneSinks: {
      dispatchPaneReset: (deviceId: string, paneId: string) => resets.push([deviceId, paneId]),
      dispatchPaneApplyHistory: (deviceId: string, paneId: string) =>
        histories.push([deviceId, paneId]),
      dispatchPaneOutput: () => {},
      dispatchPaneTerminalData: () => {},
      dispatchPaneScreenSnapshot: () => {},
      dispatchPaneHistoryPage: () => {},
      dispatchPaneRebase: () => {},
      // token gate 未命中：交给选择状态机处理（select 路径）
      dispatchPaneHistory: () => false,
      beginPaneHistoryGate: () => {},
      cleanupDevicePaneState: () => {},
    },
    notifications: { info: () => {}, success: () => {}, warning: () => {}, error: () => {} },
    bell: { play: () => {} },
    t: (key: string) => key,
    host: { navigate: () => {} },
    features: { hostManagedNotifications: false },
  } as unknown as RuntimeCore;

  const ui = {
    getState: () => ({ theme: 'dark' }),
    subscribe: () => () => {},
  } as unknown as UIStore;
  const site = { getState: () => ({ settings: undefined }) } as unknown as SiteStore;

  const disposers: Array<() => void> = [];
  const store = createTmuxStore(core, { getUI: () => ui, getSite: () => site }, disposers);
  store.getState().ensureSocketConnected();

  const selectCommands = (): SelectCommand[] =>
    commands.filter((command): command is SelectCommand => command.type === 'select-pane');

  function lastToken(): Uint8Array {
    const token = selectCommands().at(-1)?.selectToken;
    if (!token) throw new Error('no select-pane command was sent');
    return token;
  }

  return {
    store,
    machine,
    commands,
    resets,
    histories,
    selectCommands,
    lastCommand: () => selectCommands().at(-1),
    select(paneId: string, warm = false): void {
      store
        .getState()
        .selectPane(DEVICE, '@1', paneId, undefined, warm ? { warm: true } : undefined);
    },
    ack(): void {
      emit?.({ type: 'selection-ack', deviceId: DEVICE, selectToken: lastToken() });
    },
    publishSnapshot(paneIds: string[]): void {
      emit?.({ type: 'metadata-snapshot', snapshot: snapshotWith(paneIds) });
    },
    /** 门控缓冲期内灌一段超限的 live：状态机标记 outputGapped 并转走 rebase */
    overflowOutputGate(paneId: string): void {
      emit?.({
        type: 'terminal-data',
        frame: { deviceId: DEVICE, paneId, data: new Uint8Array(64) },
      } as unknown as GatewayTransportEvent);
    },
    publishDeviceEvent(event: Record<string, unknown>): void {
      emit?.({
        type: 'device-event',
        event: { deviceId: DEVICE, ...event },
      } as unknown as GatewayTransportEvent);
    },
    /** 完整落定一笔冷 select：history + live-resume */
    complete(paneId: string): void {
      const selectToken = lastToken();
      emit?.({
        type: 'legacy-history',
        deviceId: DEVICE,
        paneId,
        selectToken,
        data: 'screen',
        alternateScreen: false,
        modes: 0,
      });
      emit?.({ type: 'live-resume', deviceId: DEVICE, selectToken });
    },
    /** 触发在途的 ack/progress 超时 */
    fireTimeouts(): void {
      timers.fireAll();
    },
    reset(): void {
      commands.length = 0;
      resets.length = 0;
      histories.length = 0;
    },
    dispose(): void {
      for (const dispose of disposers) dispose();
    },
  };
}

describe('warm select on the real SelectStateMachine', () => {
  test('cold select asks for history and drives a full transaction', () => {
    const harness = createHarness();
    harness.select('%1');
    expect(harness.lastCommand()?.wantHistory).toBe(true);

    harness.ack();
    harness.complete('%1');

    expect(harness.resets).toEqual([[DEVICE, '%1']]);
    expect(harness.histories).toEqual([[DEVICE, '%1']]);
    expect(harness.machine.getTransaction(DEVICE)).toBeUndefined();
    expect(harness.machine.isBuffering(DEVICE)).toBe(false);
    harness.dispose();
  });

  test('warm select skips history and never resets the live terminal', () => {
    const harness = createHarness();
    harness.select('%1');
    harness.ack();
    harness.complete('%1');
    harness.reset();

    harness.select('%2', true);

    expect(harness.lastCommand()?.wantHistory).toBe(false);
    expect(harness.resets).toEqual([]);
    expect(harness.histories).toEqual([]);
    expect(harness.machine.getTransaction(DEVICE)).toBeUndefined();
    // 没有事务就没有门控：warm pane 的 live 直通
    expect(harness.machine.isBuffering(DEVICE)).toBe(false);
    harness.dispose();
  });

  test('cold in-flight → warm interrupt tears down the stale transaction and its gate', () => {
    const harness = createHarness();
    // %1 的冷 select 收到 ACK，history 还没到
    harness.select('%1');
    harness.ack();
    expect(harness.machine.getTransaction(DEVICE)?.paneId).toBe('%1');
    expect(harness.machine.isBuffering(DEVICE)).toBe(true);

    harness.select('%2', true);

    // 网关已经取消了 %1 的 barrier：客户端这边的旧事务与门控必须一起没
    expect(harness.machine.getTransaction(DEVICE)).toBeUndefined();
    expect(harness.machine.isBuffering(DEVICE)).toBe(false);
    expect(harness.lastCommand()?.wantHistory).toBe(false);
    harness.dispose();
  });

  test('the interrupted pane is gapped, so switching back is cold', () => {
    const harness = createHarness();
    harness.select('%1');
    harness.ack();
    harness.select('%2', true);
    harness.reset();

    harness.select('%1', true);

    expect(harness.lastCommand()?.wantHistory).toBe(true);
    expect(harness.machine.getTransaction(DEVICE)?.paneId).toBe('%1');
    harness.dispose();
  });

  test('gap recovery that times out keeps the gap: the next visit is still cold', () => {
    const harness = createHarness();
    harness.select('%1');
    harness.ack();
    harness.select('%2', true); // %1 被打断 → 记缺口

    // 补洞的冷 select 没跑完就超时
    harness.select('%1', true);
    expect(harness.lastCommand()?.wantHistory).toBe(true);
    harness.ack();
    harness.fireTimeouts();
    expect(harness.machine.getTransaction(DEVICE)).toBeUndefined();

    harness.reset();
    harness.select('%2', true);
    harness.select('%1', true);

    // 补洞没落定，缺口留着
    expect(harness.selectCommands().at(-1)?.wantHistory).toBe(true);
    harness.dispose();
  });

  test('gap recovery that completes clears the gap: the next visit is warm', () => {
    const harness = createHarness();
    harness.select('%1');
    harness.ack();
    harness.select('%2', true); // %1 被打断 → 记缺口

    harness.select('%1', true); // 被否决成冷路径
    harness.ack();
    harness.complete('%1'); // 这次真的落定了

    harness.reset();
    harness.select('%2', true);
    harness.select('%1', true);

    expect(harness.selectCommands().at(-1)?.wantHistory).toBe(false);
    expect(harness.resets).toEqual([]);
    harness.dispose();
  });

  test('warm select onto the pane whose own select is still in flight goes cold', () => {
    const harness = createHarness();
    harness.select('%1');
    harness.ack();
    harness.reset();

    harness.select('%1', true);

    expect(harness.lastCommand()?.wantHistory).toBe(true);
    // 新 token 接管门控，旧的那笔被 SELECT_START 取消
    expect(harness.machine.getTransaction(DEVICE)?.selectToken).toEqual(
      harness.lastCommand()?.selectToken as Uint8Array
    );
    harness.dispose();
  });

  test('connected → reconnecting → reconnected cold-selects the current pane', () => {
    const harness = createHarness();
    harness.publishSnapshot(['%1', '%2']);
    harness.select('%1');
    harness.ack();
    harness.complete('%1');
    harness.select('%2', true);
    harness.reset();

    // 自动重连只发 error/reconnecting（deviceConnected 仍为 true），但流确实断了
    harness.publishDeviceEvent({ type: 'error', errorType: 'reconnecting', message: 'retry' });
    expect(harness.machine.getTransaction(DEVICE)).toBeUndefined();
    expect(harness.machine.isBuffering(DEVICE)).toBe(false);

    harness.publishDeviceEvent({ type: 'reconnected' });

    // 旧事务已经被清掉，maybeReselectCurrentPane 不会早退：当前 pane 走完整 select
    const reselect = harness.selectCommands().at(-1);
    expect(reselect?.paneId).toBe('%2');
    expect(reselect?.wantHistory).toBe(true);
    harness.dispose();
  });

  test('every pane of the device loses warm eligibility across a reconnect', () => {
    const harness = createHarness();
    harness.publishSnapshot(['%1', '%2']);
    harness.select('%1');
    harness.ack();
    harness.complete('%1');

    harness.publishDeviceEvent({ type: 'error', errorType: 'reconnecting', message: 'retry' });
    harness.publishDeviceEvent({ type: 'reconnected' });
    harness.reset();

    // 中断期间谁都可能漏字节：任何 pane 的 warm 请求都要退回冷路径
    harness.select('%2', true);
    expect(harness.selectCommands().at(-1)?.wantHistory).toBe(true);
    harness.select('%1', true);
    expect(harness.selectCommands().at(-1)?.wantHistory).toBe(true);
    harness.dispose();
  });

  test('a repair whose history was skipped by an output-gate overflow keeps the gap', () => {
    const harness = createHarness();
    harness.publishSnapshot(['%1', '%2']);
    harness.select('%1');
    harness.ack();
    harness.select('%2', true); // %1 被打断 → 记缺口

    // 补洞的冷 select：ACK 后门控溢出，状态机会跳过 reset/apply 但照常摘除事务
    harness.select('%1', true);
    harness.ack();
    harness.overflowOutputGate('%1');
    harness.complete('%1');
    expect(harness.machine.getTransaction(DEVICE)).toBeUndefined();
    // 画面是靠 rebase 重建的，history 没落地：缺口必须留着
    harness.reset();
    harness.select('%2', true);
    harness.select('%1', true);

    expect(harness.selectCommands().at(-1)?.wantHistory).toBe(true);
    harness.dispose();
  });
});
