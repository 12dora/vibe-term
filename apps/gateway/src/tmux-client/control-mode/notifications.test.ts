import { describe, expect, test } from 'bun:test';
import {
  LINE_KIND_HANDLERS,
  createNotificationParseState,
  dispatchControlModeLine,
} from './notifications';
import type { ControlModeBlock, ControlModeNotification } from './types';

const encoder = new TextEncoder();

describe('LINE_KIND_HANDLERS', () => {
  test('covers framing and stream notification kinds', () => {
    expect(Object.keys(LINE_KIND_HANDLERS).sort()).toEqual([
      'begin',
      'end',
      'error',
      'exit',
      'extended-output',
      'output',
    ]);
  });
});

describe('dispatchControlModeLine', () => {
  test('keeps unknown percent-lines inside a block as body, known kinds as notifications', () => {
    const notifications: ControlModeNotification[] = [];
    const blocks: ControlModeBlock[] = [];
    const outputs: Array<{ paneId: string; data: number[] }> = [];
    const state = createNotificationParseState();
    const callbacks = {
      onOutput: (paneId: string, data: Uint8Array) => {
        outputs.push({ paneId, data: Array.from(data) });
      },
      onNotification: (notification: ControlModeNotification) => {
        notifications.push(notification);
      },
      onExit: () => {},
      onBlockEnd: (block: ControlModeBlock) => {
        blocks.push(block);
      },
    };

    for (const line of [
      '%begin 1 1 0',
      'body',
      '%window-add @9',
      '%unknown-inside x',
      '%output %1 hi',
      '%end 1 1 0',
    ]) {
      dispatchControlModeLine(callbacks, state, encoder.encode(line));
    }

    expect(notifications.map((item) => item.type)).toEqual(['window-add']);
    expect(outputs).toEqual([{ paneId: '%1', data: [0x68, 0x69] }]);
    expect(blocks).toEqual([
      { args: '1 1 0', isError: false, lines: ['body', '%unknown-inside x'] },
    ]);
  });
});
