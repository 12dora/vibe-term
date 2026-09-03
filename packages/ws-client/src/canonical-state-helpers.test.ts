import { describe, expect, test } from 'bun:test';
import { clonePendingCommand } from './canonical-state-helpers';
import type { GatewayTransportCommand } from './transport-types';

describe('clonePendingCommand', () => {
  test('deep-copies mutable fields for screen, history, select and list commands', () => {
    const requestId = new Uint8Array(16).fill(1);
    const selectToken = new Uint8Array(16).fill(2);
    const paneEpoch = new Uint8Array(16).fill(3);
    const historyEpoch = new Uint8Array(16).fill(4);

    const screen = clonePendingCommand({
      type: 'request-pane-screen',
      requestId,
      deviceId: 'd',
      paneId: '%1',
      byteLimit: 8,
    });
    if (screen.type !== 'request-pane-screen') throw new Error('screen');
    expect(screen.requestId).toEqual(requestId);
    expect(screen.requestId).not.toBe(requestId);
    screen.requestId.fill(9);
    expect(requestId[0]).toBe(1);

    const history: GatewayTransportCommand = {
      type: 'request-pane-history',
      requestId,
      deviceId: 'd',
      paneId: '%1',
      cursor: { paneEpoch, historyEpoch, beforeLine: 12 },
      byteLimit: 8,
    };
    const historyClone = clonePendingCommand(history);
    if (historyClone.type !== 'request-pane-history' || !historyClone.cursor) {
      throw new Error('history');
    }
    expect(historyClone.cursor.paneEpoch).not.toBe(paneEpoch);
    historyClone.cursor.paneEpoch.fill(9);
    expect(paneEpoch[0]).toBe(3);

    const select = clonePendingCommand({
      type: 'select-pane',
      deviceId: 'd',
      windowId: '@1',
      paneId: '%1',
      selectToken,
    });
    if (select.type !== 'select-pane') throw new Error('select');
    expect(select.selectToken).not.toBe(selectToken);

    const paneIds = ['%1'];
    const subscriptions = clonePendingCommand({
      type: 'set-pane-subscriptions',
      deviceId: 'd',
      generation: 1n,
      paneIds,
    });
    if (subscriptions.type !== 'set-pane-subscriptions') throw new Error('subs');
    subscriptions.paneIds.push('%2');
    expect(paneIds).toEqual(['%1']);

    const windows = clonePendingCommand({
      type: 'reorder-windows',
      deviceId: 'd',
      windowIds: ['@1'],
    });
    if (windows.type !== 'reorder-windows') throw new Error('windows');
    windows.windowIds.push('@2');

    const panes = clonePendingCommand({
      type: 'reorder-panes',
      deviceId: 'd',
      windowId: '@1',
      paneIds: ['%1'],
    });
    if (panes.type !== 'reorder-panes') throw new Error('panes');
    panes.paneIds.push('%2');

    const input: GatewayTransportCommand = {
      type: 'terminal-input',
      deviceId: 'd',
      paneId: '%1',
      data: 'x',
      isComposing: false,
    };
    const inputClone = clonePendingCommand(input);
    expect(inputClone).toEqual(input);
    expect(inputClone).not.toBe(input);
  });
});
