import { describe, expect, test } from 'bun:test';
import type { TmuxSourceMetadataEvent } from './events';
import type { PaneStreamNotification } from './pane-stream-parser';

import { createControlModeSubscription } from './control-mode-subscription';

const encoder = new TextEncoder();

function lines(...items: string[]): Uint8Array {
  return encoder.encode(`${items.join('\n')}\n`);
}

type SubTrace = {
  outputs: Array<{ paneId: string; text: string }>;
  titles: Array<{ paneId: string; title: string }>;
  bells: string[];
  notifications: Array<{ paneId: string; notification: PaneStreamNotification }>;
  pauses: string[];
  continues: string[];
  metadata: TmuxSourceMetadataEvent[];
  exits: Array<string | null>;
};

function trace(chunks: Uint8Array[]): SubTrace {
  const collected: SubTrace = {
    outputs: [],
    titles: [],
    bells: [],
    notifications: [],
    pauses: [],
    continues: [],
    metadata: [],
    exits: [],
  };
  const subscription = createControlModeSubscription({
    onTerminalOutput: (paneId, data) => {
      collected.outputs.push({ paneId, text: new TextDecoder().decode(data) });
    },
    onTitle: (paneId, title) => {
      collected.titles.push({ paneId, title });
    },
    onBell: (paneId) => {
      collected.bells.push(paneId);
    },
    onNotification: (paneId, notification) => {
      collected.notifications.push({ paneId, notification });
    },
    onPause: (paneId) => {
      collected.pauses.push(paneId);
    },
    onContinue: (paneId) => {
      collected.continues.push(paneId);
    },
    onSourceMetadata: (event) => {
      collected.metadata.push(event);
    },
    onStructureChanged: () => {},
    onExit: (reason) => {
      collected.exits.push(reason);
    },
  });
  for (const chunk of chunks) {
    subscription.push(chunk);
  }
  subscription.end();
  subscription.dispose();
  return collected;
}

function splitEveryByte(data: Uint8Array): Uint8Array[] {
  return Array.from(data, (byte) => new Uint8Array([byte]));
}

function expectGolden(input: Uint8Array, expected: SubTrace): void {
  const whole = trace([input]);
  expect(whole).toEqual(expected);
  expect(trace(splitEveryByte(input))).toEqual(whole);
  if (input.length > 3) {
    const mid = Math.floor(input.length / 2);
    expect(trace([input.subarray(0, mid), input.subarray(mid)])).toEqual(whole);
  }
}

describe('control mode subscription golden traces', () => {
  test('routes output, bell, title and OSC 9 across panes', () => {
    expectGolden(
      lines(
        '%output %1 hello',
        '%output %1 A\\007B',
        '%output %4 \\033]9;hi from claude\\007',
        '%output %1 \\033]2;my-title\\007'
      ),
      {
        outputs: [
          { paneId: '%1', text: 'hello' },
          { paneId: '%1', text: 'AB' },
        ],
        titles: [{ paneId: '%1', title: 'my-title' }],
        bells: ['%1'],
        notifications: [{ paneId: '%4', notification: { source: 'osc9', body: 'hi from claude' } }],
        pauses: [],
        continues: [],
        metadata: [],
        exits: [],
      }
    );
  });

  test('session-changed then session-renamed (name-only) plus structural metadata', () => {
    expectGolden(
      lines(
        '%session-changed $0 t1',
        '%session-renamed work',
        '%layout-change @1 x y !',
        '%window-renamed @1 zsh',
        '%window-close @1',
        '%unlinked-window-close @2',
        '%pause %1',
        '%continue %1',
        '%exit detached'
      ),
      {
        outputs: [],
        titles: [],
        bells: [],
        notifications: [],
        pauses: ['%1'],
        continues: ['%1'],
        metadata: [
          { type: 'session-renamed', sessionId: '$0', name: 'work' },
          { type: 'layout-change', windowId: '@1', layout: 'x' },
          { type: 'window-renamed', windowId: '@1', name: 'zsh' },
          { type: 'window-close', windowId: '@1' },
          { type: 'window-close', windowId: '@2' },
        ],
        exits: ['detached'],
      }
    );
  });

  test('keeps per-pane parser state when OSC 9 is split across %output lines', () => {
    expectGolden(lines('%output %1 \\033]9;part', '%output %2 plain', '%output %1 ial\\007'), {
      outputs: [{ paneId: '%2', text: 'plain' }],
      titles: [],
      bells: [],
      notifications: [{ paneId: '%1', notification: { source: 'osc9', body: 'partial' } }],
      pauses: [],
      continues: [],
      metadata: [],
      exits: [],
    });
  });
});
