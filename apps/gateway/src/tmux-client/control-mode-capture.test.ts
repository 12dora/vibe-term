import { describe, expect, test } from 'bun:test';

import {
  ControlModeCommandQueue,
  capturePaneFrameAtControlBarrier,
} from './control-mode-capture';
import { createControlModeParser } from './control-mode-parser';

const encoder = new TextEncoder();

describe('control-mode atomic capture', () => {
  test('aligns command blocks and keeps notification-looking screen lines literal', async () => {
    const writes: string[] = [];
    const events: string[] = [];
    const queue = new ControlModeCommandQueue();
    const parser = createControlModeParser({
      onOutput: () => events.push('output'),
      onNotification: () => events.push('notification'),
      onExit: () => {},
      onBlockBegin: () => queue.nextBlockIsLiteral(),
      onBlockEnd: (block) => {
        queue.handleBlock(block);
        events.push('block-end');
      },
    });
    const capturePromise = capturePaneFrameAtControlBarrier(
      queue,
      (command) => writes.push(command),
      '%1',
      50,
      () => events.push('barrier')
    );
    expect(writes).toHaveLength(2);
    parser.push(
      encoder.encode(
        '%begin 1 2 0\n80|24|0|3|4|200\n%end 1 2 0\n' +
          '%begin 1 3 0\n%output this is terminal text\n%window-add also terminal text\n' +
          '%end 1 3 0\n%output %1 live\n'
      )
    );

    const capture = await capturePromise;
    expect(capture).toEqual({
      text: '%output this is terminal text\n%window-add also terminal text',
      cols: 80,
      rows: 24,
      cursorX: 3,
      cursorY: 4,
      alternateScreen: false,
      historySize: 200,
    });
    expect(events).toEqual(['block-end', 'barrier', 'block-end', 'output']);
    expect(writes[1]).toBe('capture-pane -p -e -J -N -t %1 -S -50\n');
    queue.dispose();
  });
});
