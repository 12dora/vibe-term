// canonical 选择面的端到端行为（原 tmux-selection-warm.test.ts）：
// legacy 选择事务下线后切换不再区分冷热，select-pane 只驱动 tmux 焦点，
// 画面由各 pane 自己的 canonical 截屏事务重建。

import { describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload, TmuxPane, TmuxWindow } from '@tmex/shared';
import type { GatewayTransportCommand, GatewayTransportEvent } from '@tmex/ws-client';
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

type SelectCommand = Extract<GatewayTransportCommand, { type: 'select-pane' }>;

function createHarness() {
  const commands: GatewayTransportCommand[] = [];
  const cleanedDevices: string[] = [];
  let emit: ((event: GatewayTransportEvent) => void) | null = null;

  const core = {
    transport: {
      capabilities: { atomicScreen: true, cursorHistory: true, sequencedTerminal: true },
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
      isReady: () => true,
      connect: () => {},
      hasConnectedOnce: false,
      latencyMs: null,
    },
    paneSinks: {
      dispatchPaneTerminalData: () => {},
      cleanupDevicePaneState: (deviceId: string) => cleanedDevices.push(deviceId),
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

  return {
    store,
    commands,
    cleanedDevices,
    selectCommands,
    lastSelect: () => selectCommands().at(-1),
    publish(event: GatewayTransportEvent): void {
      emit?.(event);
    },
    select(paneId: string, warm = false, size?: { cols: number; rows: number }): void {
      store.getState().selectPane(DEVICE, '@1', paneId, size, warm ? { warm: true } : undefined);
    },
    reset(): void {
      commands.length = 0;
    },
    dispose(): void {
      for (const dispose of disposers) dispose();
    },
  };
}

describe('canonical selection actions', () => {
  test('select-pane 记录选中并下发到网关', () => {
    const harness = createHarness();
    harness.publish({ type: 'metadata-snapshot', snapshot: snapshotWith(['%1', '%2']) });

    harness.select('%2');

    expect(harness.store.getState().selectedPanes[DEVICE]).toEqual({
      windowId: '@1',
      paneId: '%2',
    });
    expect(harness.lastSelect()).toMatchObject({ deviceId: DEVICE, windowId: '@1', paneId: '%2' });
    expect(harness.lastSelect()?.selectToken.byteLength).toBe(16);
    harness.dispose();
  });

  test('warm 提示不再改变下发内容：冷热两次 select 完全同形', () => {
    const harness = createHarness();
    harness.publish({ type: 'metadata-snapshot', snapshot: snapshotWith(['%1', '%2']) });

    harness.select('%1');
    harness.select('%2', true);

    const [cold, warm] = harness.selectCommands();
    expect(Object.keys(cold ?? {}).sort()).toEqual(Object.keys(warm ?? {}).sort());
    expect(cold).not.toHaveProperty('wantHistory');
    harness.dispose();
  });

  test('未带尺寸时回落到最近一次上报的终端尺寸，显式尺寸优先', () => {
    const harness = createHarness();
    harness.publish({ type: 'metadata-snapshot', snapshot: snapshotWith(['%1']) });

    harness.select('%1');
    expect(harness.lastSelect()?.cols).toBeUndefined();

    harness.store.getState().resizePane(DEVICE, '%1', 120, 40);
    harness.select('%1');
    expect(harness.lastSelect()).toMatchObject({ cols: 120, rows: 40 });

    harness.select('%1', false, { cols: 90, rows: 30 });
    expect(harness.lastSelect()).toMatchObject({ cols: 90, rows: 30 });
    harness.dispose();
  });

  test('设备流中断只丢 pane 缓冲，不再触发重新选择', () => {
    const harness = createHarness();
    harness.publish({ type: 'metadata-snapshot', snapshot: snapshotWith(['%1']) });
    harness.select('%1');
    harness.reset();

    harness.publish({
      type: 'device-event',
      event: {
        type: 'error',
        deviceId: DEVICE,
        errorType: 'reconnecting',
        message: 'retry',
      },
    } as unknown as GatewayTransportEvent);
    harness.publish({
      type: 'device-event',
      event: { type: 'reconnected', deviceId: DEVICE },
    } as unknown as GatewayTransportEvent);

    expect(harness.cleanedDevices).toEqual([DEVICE]);
    expect(harness.selectCommands()).toEqual([]);
    harness.dispose();
  });

  test('快照移除选中的 pane 后清空选中记录', () => {
    const harness = createHarness();
    harness.publish({ type: 'metadata-snapshot', snapshot: snapshotWith(['%1', '%2']) });
    harness.select('%2');

    harness.publish({ type: 'metadata-snapshot', snapshot: snapshotWith(['%1']) });

    expect(harness.store.getState().selectedPanes[DEVICE]).toBeUndefined();
    harness.dispose();
  });

  test('selectWindow / focusPane 直接下发对应命令', () => {
    const harness = createHarness();
    harness.reset();

    harness.store.getState().selectWindow(DEVICE, '@2');
    harness.store.getState().focusPane(DEVICE, '@1', '%3');

    expect(harness.commands.map((command) => command.type)).toEqual([
      'select-window',
      'focus-pane',
    ]);
    expect(harness.store.getState().selectedPanes[DEVICE]).toEqual({
      windowId: '@1',
      paneId: '%3',
    });
    harness.dispose();
  });
});
