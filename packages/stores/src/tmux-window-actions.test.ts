import { describe, expect, test } from 'bun:test';
import type { GatewayTransportCommand } from '@tmex/ws-client';
import type { RuntimeCore } from './runtime';
import type { TmuxState } from './tmux-state';
import { createTmuxWindowActions } from './tmux-window-actions';

function createHarness() {
  const commands: GatewayTransportCommand[] = [];
  const calls: Array<{ name: string; args: unknown[] }> = [];
  let state = { pendingCreateWindowAt: {} } as TmuxState;

  const core = {
    transport: {
      send(command: GatewayTransportCommand) {
        commands.push(command);
      },
    },
  } as unknown as RuntimeCore;

  const paneSubscriptions = {
    setManualSubscriptions: (...args: unknown[]) => {
      calls.push({ name: 'setManualSubscriptions', args });
    },
    mountPane: (...args: unknown[]) => {
      calls.push({ name: 'mountPane', args });
      return () => {};
    },
    requestPaneScreen: (...args: unknown[]) => {
      calls.push({ name: 'requestPaneScreen', args });
    },
    fetchPaneHistory: (...args: unknown[]) => {
      calls.push({ name: 'fetchPaneHistory', args });
    },
  } as unknown as Parameters<typeof createTmuxWindowActions>[1]['paneSubscriptions'];

  const actions = createTmuxWindowActions(core, {
    setState: (partial) => {
      const next = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...next };
    },
    paneSubscriptions,
  });

  return { actions, commands, calls, getState: () => state };
}

describe('tmux window actions', () => {
  test('结构与输入动作按契约下发命令', () => {
    const h = createHarness();
    h.actions.sendInput('d', '%1', 'ls', true);
    h.actions.paste('d', '%1', 'text');
    h.actions.closeWindow('d', '@1');
    h.actions.closePane('d', '%1');
    h.actions.renameWindow('d', '@1', 'name');
    h.actions.splitPane('d', '%1', 'right', '/tmp');
    h.actions.renamePane('d', '%1', 'pane');
    h.actions.movePane('d', '%1', '%2', 'right');
    h.actions.breakPane('d', '%1');

    expect(h.commands).toEqual([
      { type: 'terminal-input', deviceId: 'd', paneId: '%1', data: 'ls', isComposing: true },
      { type: 'terminal-paste', deviceId: 'd', paneId: '%1', data: 'text' },
      { type: 'close-window', deviceId: 'd', windowId: '@1' },
      { type: 'close-pane', deviceId: 'd', paneId: '%1' },
      { type: 'rename-window', deviceId: 'd', windowId: '@1', name: 'name' },
      { type: 'split-pane', deviceId: 'd', paneId: '%1', direction: 'right', cwd: '/tmp' },
      { type: 'rename-pane', deviceId: 'd', paneId: '%1', name: 'pane' },
      { type: 'move-pane', deviceId: 'd', srcPaneId: '%1', dstPaneId: '%2', position: 'right' },
      { type: 'break-pane', deviceId: 'd', paneId: '%1' },
    ]);
  });

  test('缺失 deviceId / paneId 或自移动时静默返回', () => {
    const h = createHarness();
    h.actions.sendInput('', '%1', 'ls');
    h.actions.paste('d', '', 'text');
    h.actions.createWindow('');
    h.actions.closeWindow('d', '');
    h.actions.splitPane('', '%1', 'down');
    h.actions.movePane('d', '%1', '%1', 'left');
    h.actions.subscribePanes('', ['%1']);
    h.actions.requestPaneScreen('d', '');

    expect(h.commands).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.actions.mountPane('d', '')).toBeInstanceOf(Function);
    expect(h.calls).toEqual([]);
  });

  test('createWindow 记账 pendingCreateWindowAt，clearPendingCreateWindow 删除', () => {
    const h = createHarness();
    h.actions.createWindow('d', 'shell', '/tmp');

    expect(h.commands).toEqual([
      { type: 'create-window', deviceId: 'd', name: 'shell', cwd: '/tmp' },
    ]);
    expect(typeof h.getState().pendingCreateWindowAt.d).toBe('number');

    h.actions.clearPendingCreateWindow('d');
    expect(h.getState().pendingCreateWindowAt.d).toBeUndefined();
    expect('d' in h.getState().pendingCreateWindowAt).toBe(false);
  });

  test('pane 订阅门面透传到 PaneSubscriptionManager', () => {
    const h = createHarness();
    h.actions.subscribePanes('d', ['%1', '%2']);
    h.actions.mountPane('d', '%1');
    h.actions.requestPaneScreen('d', '%1');
    h.actions.fetchPaneHistory('d', '%1');

    expect(h.calls).toEqual([
      { name: 'setManualSubscriptions', args: ['d', ['%1', '%2']] },
      { name: 'mountPane', args: ['d', '%1'] },
      { name: 'requestPaneScreen', args: ['d', '%1'] },
      { name: 'fetchPaneHistory', args: ['d', '%1', null] },
    ]);
  });
});
