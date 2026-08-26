import { describe, expect, test } from 'bun:test';

import {
  type ControlModeBlock,
  type ControlModeNotification,
  createControlModeParser,
} from './control-mode-parser';

const encoder = new TextEncoder();

function bytes(...parts: Array<number | string | Uint8Array>): Uint8Array {
  const list: number[] = [];
  for (const part of parts) {
    if (typeof part === 'number') {
      list.push(part);
    } else if (typeof part === 'string') {
      list.push(...encoder.encode(part));
    } else {
      list.push(...part);
    }
  }
  return new Uint8Array(list);
}

type ParserTrace = {
  outputs: Array<{ paneId: string; data: number[] }>;
  notifications: ControlModeNotification[];
  exits: Array<string | null>;
  blocks: ControlModeBlock[];
};

function trace(chunks: Uint8Array[], literalArgs?: Set<string>): ParserTrace {
  const collected: ParserTrace = { outputs: [], notifications: [], exits: [], blocks: [] };
  const parser = createControlModeParser({
    onOutput: (paneId, data) => {
      collected.outputs.push({ paneId, data: Array.from(data) });
    },
    onNotification: (notification) => {
      collected.notifications.push(notification);
    },
    onExit: (reason) => {
      collected.exits.push(reason);
    },
    onBlockBegin: (args) => literalArgs?.has(args) ?? false,
    onBlockEnd: (block) => {
      collected.blocks.push({
        args: block.args,
        isError: block.isError,
        lines: [...block.lines],
      });
    },
  });
  for (const chunk of chunks) {
    parser.push(chunk);
  }
  parser.end();
  return collected;
}

function splitEveryByte(data: Uint8Array): Uint8Array[] {
  return Array.from(data, (byte) => new Uint8Array([byte]));
}

function expectGolden(input: Uint8Array, expected: ParserTrace, literalArgs?: Set<string>): void {
  const whole = trace([input], literalArgs);
  expect(whole).toEqual(expected);
  expect(trace(splitEveryByte(input), literalArgs)).toEqual(whole);
  if (input.length > 3) {
    const mid = Math.floor(input.length / 2);
    expect(trace([input.subarray(0, mid), input.subarray(mid)], literalArgs)).toEqual(whole);
  }
}

describe('control mode parser golden traces', () => {
  test('attach greeting, session-changed and exit (tmux 3.4)', () => {
    expectGolden(
      bytes('%begin 1781125427 276 0\n%end 1781125427 276 0\n%session-changed $0 t1\n%exit\n'),
      {
        outputs: [],
        notifications: [{ type: 'session-changed', args: '$0 t1', raw: '%session-changed $0 t1' }],
        exits: [null],
        blocks: [{ args: '1781125427 276 0', isError: false, lines: [] }],
      }
    );
  });

  test('%output with octal escapes, raw UTF-8 and a following notification', () => {
    expectGolden(
      bytes('%output %0 A\\011B\\134C', 0xe4, 0xb8, 0xad, '\\015\\012\n%window-add @2\n'),
      {
        outputs: [
          {
            paneId: '%0',
            data: [0x41, 0x09, 0x42, 0x5c, 0x43, 0xe4, 0xb8, 0xad, 0x0d, 0x0a],
          },
        ],
        notifications: [{ type: 'window-add', args: '@2', raw: '%window-add @2' }],
        exits: [],
        blocks: [],
      }
    );
  });

  test('literal capture block keeps notification-looking screen lines', () => {
    expectGolden(
      bytes(
        '%begin 1 3 0\n%output this is terminal text\n%window-add also terminal text\n%end 1 3 0\n%output %1 live\n'
      ),
      {
        outputs: [{ paneId: '%1', data: Array.from(encoder.encode('live')) }],
        notifications: [],
        exits: [],
        blocks: [
          {
            args: '1 3 0',
            isError: false,
            lines: ['%output this is terminal text', '%window-add also terminal text'],
          },
        ],
      },
      new Set(['1 3 0'])
    );
  });

  test('interleaved known notifications inside a command block', () => {
    expectGolden(
      bytes(
        '%begin 100 3 0\nbody line\n%window-add @9\n%output %1 hi\n%unknown-inside x\n%end 100 3 0\n'
      ),
      {
        outputs: [{ paneId: '%1', data: [0x68, 0x69] }],
        notifications: [{ type: 'window-add', args: '@9', raw: '%window-add @9' }],
        exits: [],
        blocks: [{ args: '100 3 0', isError: false, lines: ['body line', '%unknown-inside x'] }],
      }
    );
  });

  test('%extended-output and %exit with a reason', () => {
    expectGolden(bytes('%extended-output %5 1234 : pay : load\\007\n%exit detached\n'), {
      outputs: [{ paneId: '%5', data: Array.from(bytes('pay : load', 0x07)) }],
      notifications: [],
      exits: ['detached'],
      blocks: [],
    });
  });

  test('blank lines inside a literal block are preserved', () => {
    expectGolden(
      bytes('%begin 9 1 0\nline\n\n\nend-row\n%end 9 1 0\n'),
      {
        outputs: [],
        notifications: [],
        exits: [],
        blocks: [{ args: '9 1 0', isError: false, lines: ['line', '', '', 'end-row'] }],
      },
      new Set(['9 1 0'])
    );
  });
});
