import { describe, expect, test } from 'bun:test';

import {
  type PaneStreamNotification,
  type PromptMarker,
  createPaneStreamParser,
} from './pane-stream-parser';

const encoder = new TextEncoder();

function bytes(...parts: Array<number | string | Uint8Array>): Uint8Array {
  const output: number[] = [];
  for (const part of parts) {
    if (typeof part === 'number') {
      output.push(part);
      continue;
    }
    if (typeof part === 'string') {
      output.push(...encoder.encode(part));
      continue;
    }
    output.push(...part);
  }
  return new Uint8Array(output);
}

function utf8ToBase64(text: string): string {
  const utf8 = encoder.encode(text);
  let binary = '';
  for (const byte of utf8) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function wrapTmuxPassthrough(inner: Uint8Array): Uint8Array {
  const body: number[] = [];
  for (const byte of inner) {
    if (byte === 0x1b) {
      body.push(0x1b, 0x1b);
      continue;
    }
    body.push(byte);
  }
  return bytes(0x1b, 'Ptmux;', new Uint8Array(body), 0x1b, 0x5c);
}

type ParserEvent =
  | { type: 'title'; title: string }
  | { type: 'path'; path: string }
  | { type: 'bell' }
  | { type: 'notification'; notification: PaneStreamNotification }
  | { type: 'prompt'; marker: PromptMarker }
  | { type: 'clipboard'; text: string }
  | { type: 'theme'; subscribed: boolean };

type Trace = {
  events: ParserEvent[];
  output: number[];
};

function trace(chunks: Uint8Array[]): Trace {
  const events: ParserEvent[] = [];
  const parser = createPaneStreamParser({
    onTitle: (title) => events.push({ type: 'title', title }),
    onCurrentPath: (path) => events.push({ type: 'path', path }),
    onBell: () => events.push({ type: 'bell' }),
    onNotification: (notification) => events.push({ type: 'notification', notification }),
    onPromptMarker: (marker) => events.push({ type: 'prompt', marker }),
    onClipboardWrite: (text) => events.push({ type: 'clipboard', text }),
    onThemeSubscription: (subscribed) => events.push({ type: 'theme', subscribed }),
  });
  const output: number[] = [];
  for (const chunk of chunks) {
    output.push(...parser.push(chunk));
  }
  return { events, output };
}

function splitEveryByte(data: Uint8Array): Uint8Array[] {
  return Array.from(data, (byte) => new Uint8Array([byte]));
}

function expectGolden(input: Uint8Array, expected: Trace): void {
  const whole = trace([input]);
  expect(whole).toEqual(expected);
  expect(trace(splitEveryByte(input))).toEqual(whole);
}

const ST = bytes(0x1b, 0x5c);

describe('pane stream parser golden traces', () => {
  test('plain text and bare BEL', () => {
    expectGolden(bytes('A', 0x07, 'B'), {
      events: [{ type: 'bell' }],
      output: [0x41, 0x42],
    });
  });

  test('OSC 2 title terminated by BEL', () => {
    expectGolden(bytes(0x1b, 0x5d, '2;dev', 0x07), {
      events: [{ type: 'title', title: 'dev' }],
      output: [],
    });
  });

  test('OSC 0 CJK title terminated by ST, surrounding bytes kept', () => {
    expectGolden(bytes('A', 0x1b, 0x5d, '0;中', ST, 'B'), {
      events: [{ type: 'title', title: '中' }],
      output: [0x41, 0x42],
    });
  });

  test('empty OSC 2 title is not emitted', () => {
    expectGolden(bytes(0x1b, 0x5d, '2;   ', 0x07, 'Z'), {
      events: [],
      output: [0x5a],
    });
  });

  test('OSC 9 without payload still notifies', () => {
    expectGolden(bytes(0x1b, 0x5d, '9', 0x07, 'Z'), {
      events: [{ type: 'notification', notification: { source: 'osc9', body: '' } }],
      output: [0x5a],
    });
  });

  test('ESC k screen title BEL then text', () => {
    expectGolden(bytes(0x1b, 0x6b, 'echo', 0x07, 'test\r\n'), {
      events: [{ type: 'title', title: 'echo' }],
      output: Array.from(bytes('test\r\n')),
    });
  });

  test('ESC k title with embedded ESC then ST', () => {
    expectGolden(bytes(0x1b, 0x6b, 'ab', 0x1b, 'xcd', ST, 'Z'), {
      events: [{ type: 'title', title: 'ab\u001bxcd' }],
      output: [0x5a],
    });
  });

  test('OSC 9 notification ignores progress payload', () => {
    expectGolden(
      bytes('A', 0x1b, 0x5d, '9;hello from tmex', 0x07, 'B', 0x1b, 0x5d, '9;4;1;42', 0x07, 'C'),
      {
        events: [
          { type: 'notification', notification: { source: 'osc9', body: 'hello from tmex' } },
        ],
        output: Array.from(bytes('ABC')),
      }
    );
  });

  test('OSC 777 keeps semicolons in body', () => {
    expectGolden(bytes(0x1b, 0x5d, '777;notify;Build finished;All 42 tests;passed', 0x07), {
      events: [
        {
          type: 'notification',
          notification: {
            source: 'osc777',
            title: 'Build finished',
            body: 'All 42 tests;passed',
          },
        },
      ],
      output: [],
    });
  });

  test('OSC 777 non-notify verb is ignored', () => {
    expectGolden(bytes(0x1b, 0x5d, '777;other;x;y', 0x07, 'Z'), {
      events: [],
      output: [0x5a],
    });
  });

  test('OSC 1337 RequestAttention vs ignored subcommand', () => {
    expectGolden(
      bytes(
        'A',
        0x1b,
        0x5d,
        '1337;RequestAttention=yes',
        0x07,
        'B',
        0x1b,
        0x5d,
        '1337;SetMark',
        0x07,
        'C'
      ),
      {
        events: [
          { type: 'notification', notification: { source: 'osc1337', body: 'RequestAttention' } },
        ],
        output: Array.from(bytes('ABC')),
      }
    );
  });

  test('unknown OSC is swallowed', () => {
    expectGolden(bytes('A', 0x1b, 0x5d, '999;secret', 0x07, 'B'), {
      events: [],
      output: Array.from(bytes('AB')),
    });
  });

  test('OSC kind longer than 16 bytes is ignored', () => {
    expectGolden(bytes(0x1b, 0x5d, `${'1'.repeat(17)};hello`, 0x07, 'Z'), {
      events: [],
      output: [0x5a],
    });
  });

  test('tmux passthrough wrapped OSC 9', () => {
    expectGolden(bytes('A', wrapTmuxPassthrough(bytes(0x1b, ']9;task done', 0x07)), 'B'), {
      events: [{ type: 'notification', notification: { source: 'osc9', body: 'task done' } }],
      output: Array.from(bytes('AB')),
    });
  });

  test('tmux passthrough wrapped OSC 777 with ST', () => {
    expectGolden(wrapTmuxPassthrough(bytes(0x1b, ']777;notify;Claude;done', ST)), {
      events: [
        { type: 'notification', notification: { source: 'osc777', title: 'Claude', body: 'done' } },
      ],
      output: [],
    });
  });

  test('kitty OSC 99 fragments aggregate by id', () => {
    expectGolden(
      bytes(
        0x1b,
        0x5d,
        '99;i=42:d=0:p=title;Claude Code',
        ST,
        0x1b,
        0x5d,
        '99;i=42:p=body;Task finished',
        ST,
        0x1b,
        0x5d,
        '99;i=42:d=1:a=focus;',
        ST,
        'Z'
      ),
      {
        events: [
          {
            type: 'notification',
            notification: { source: 'osc99', title: 'Claude Code', body: 'Task finished' },
          },
        ],
        output: [0x5a],
      }
    );
  });

  test('kitty OSC 99 pending overflow evicts oldest id', () => {
    const fragments: Array<number | string | Uint8Array> = [];
    for (let id = 0; id < 17; id += 1) {
      fragments.push(0x1b, 0x5d, `99;i=${id}:d=0:p=title;T${id}`, ST);
    }
    fragments.push(0x1b, 0x5d, '99;i=0:d=1;', ST);
    fragments.push(0x1b, 0x5d, '99;i=1:d=1;', ST);
    fragments.push('Z');
    expectGolden(bytes(...fragments), {
      events: [{ type: 'notification', notification: { source: 'osc99', title: 'T1', body: '' } }],
      output: [0x5a],
    });
  });

  test('non-tmux DCS passes through unchanged', () => {
    const input = bytes('A', 0x1b, 'P+q544e', ST, 'B');
    expectGolden(input, {
      events: [],
      output: Array.from(input),
    });
  });

  test('DCS prefix mismatch after partial tmux; emits collected prefix', () => {
    expectGolden(bytes(0x1b, 'PtZ'), {
      events: [],
      output: Array.from(bytes(0x1b, 'PtZ')),
    });
  });

  test('OSC body keeps ESC followed by regular bytes', () => {
    expectGolden(bytes(0x1b, 0x5d, '9;ab', 0x1b, 'xcd', 0x07, 'Z'), {
      events: [{ type: 'notification', notification: { source: 'osc9', body: 'ab\u001bxcd' } }],
      output: [0x5a],
    });
  });

  test('OSC 52 clipboard BEL and UTF-8 payload', () => {
    expectGolden(bytes('X', 0x1b, ']', '52;c;aGVsbG8=', 0x07, 'Y'), {
      events: [{ type: 'clipboard', text: 'hello' }],
      output: [0x58, 0x59],
    });
  });

  test('OSC 52 UTF-8 clipboard with ST', () => {
    const payload = utf8ToBase64('你好');
    expectGolden(bytes(0x1b, ']', `52;c;${payload}`, ST, 'Z'), {
      events: [{ type: 'clipboard', text: '你好' }],
      output: [0x5a],
    });
  });

  test('OSC 52 read request and empty payload are discarded', () => {
    expectGolden(bytes(0x1b, ']', '52;c;?', 0x07, 0x1b, ']', '52;c;', 0x07, 'Z'), {
      events: [],
      output: [0x5a],
    });
  });

  test('OSC 52 without separator is discarded', () => {
    expectGolden(bytes(0x1b, ']', '52', 0x07, 'Z'), {
      events: [],
      output: [0x5a],
    });
  });

  test('CSI ?2031h/l reports subscription and passes bytes through', () => {
    const input = bytes('X', 0x1b, '[?2031h', 'Y', 0x1b, '[?2031l', 'Z');
    expectGolden(input, {
      events: [
        { type: 'theme', subscribed: true },
        { type: 'theme', subscribed: false },
      ],
      output: Array.from(input),
    });
  });

  test('CSI combined private modes include 2031', () => {
    const input = bytes(0x1b, '[?1004;2031h');
    expectGolden(input, {
      events: [{ type: 'theme', subscribed: true }],
      output: Array.from(input),
    });
  });

  test('unrelated CSI and lookalike 20316 do not subscribe', () => {
    const input = bytes(0x1b, '[1;31m', 0x1b, '[2J', 0x1b, '[?1004h', 0x1b, '[?20316h');
    expectGolden(input, {
      events: [],
      output: Array.from(input),
    });
  });

  test('CSI interrupted by ESC starts a new sequence', () => {
    const input = bytes(0x1b, '[?20', 0x1b, '[?2031h');
    expectGolden(input, {
      events: [{ type: 'theme', subscribed: true }],
      output: Array.from(input),
    });
  });

  test('long CSI is echoed verbatim', () => {
    const input = bytes(0x1b, '[', '9'.repeat(80), 'm');
    expectGolden(input, {
      events: [],
      output: Array.from(input),
    });
  });

  test('tmux passthrough CSI ?2031h is not reported', () => {
    const input = wrapTmuxPassthrough(bytes(0x1b, '[?2031h'));
    expectGolden(input, {
      events: [],
      output: Array.from(bytes(0x1b, '[?2031h')),
    });
  });

  test('tmux passthrough ending on incomplete CSI is flushed back', () => {
    const input = bytes(wrapTmuxPassthrough(bytes(0x1b, '[?20')), 'Z');
    expectGolden(input, {
      events: [],
      output: Array.from(bytes(0x1b, '[?20', 'Z')),
    });
  });

  test('tmux passthrough unwraps doubled ESC in body', () => {
    expectGolden(wrapTmuxPassthrough(bytes('A', 0x1b, 'B')), {
      events: [],
      output: Array.from(bytes('A', 0x1b, 'B')),
    });
  });

  test('OSC 7 current path', () => {
    expectGolden(bytes('A', 0x1b, ']7;file://host/work/my%20repo', 0x07, 'B'), {
      events: [{ type: 'path', path: '/work/my repo' }],
      output: Array.from(bytes('AB')),
    });
  });

  test('OSC 7 invalid URL is ignored', () => {
    expectGolden(bytes(0x1b, ']7;not-a-url', 0x07, 'Z'), {
      events: [],
      output: [0x5a],
    });
  });

  test('OSC 133 C/D markers including nonce', () => {
    expectGolden(bytes('X', 0x1b, ']', '133;C', ST, 'Y', 0x1b, ']', '133;D;137;tmex=abc123', ST), {
      events: [
        { type: 'prompt', marker: { kind: 'C', exitCode: null, params: [] } },
        { type: 'prompt', marker: { kind: 'D', exitCode: 137, params: ['137', 'tmex=abc123'] } },
      ],
      output: [0x58, 0x59],
    });
  });

  test('OSC 133 unknown subcommand is ignored', () => {
    expectGolden(bytes(0x1b, ']', '133;Z', ST, 'Q'), {
      events: [],
      output: [0x51],
    });
  });

  test('tmux passthrough wrapped OSC 133', () => {
    expectGolden(wrapTmuxPassthrough(bytes(0x1b, ']', '133;D;0', ST)), {
      events: [{ type: 'prompt', marker: { kind: 'D', exitCode: 0, params: ['0'] } }],
      output: [],
    });
  });

  test('UTF-8 text outside escapes is passed through', () => {
    expectGolden(bytes('你好', 0x07, '世界'), {
      events: [{ type: 'bell' }],
      output: Array.from(bytes('你好世界')),
    });
  });

  test('oversized ESC k title is dropped and parsing resumes', () => {
    expectGolden(bytes(0x1b, 'k', 'x'.repeat(9 * 1024), 0x07, 'ok'), {
      events: [],
      output: Array.from(bytes('ok')),
    });
  });

  test('oversized OSC payload is dropped', () => {
    expectGolden(bytes(0x1b, ']', '52;c;', 'A'.repeat(9000), 0x07, 'Z'), {
      events: [],
      output: [0x5a],
    });
  });

  test('kitchen sink mixed protocols preserve callback order', () => {
    const input = bytes(
      'A',
      0x07,
      0x1b,
      ']',
      '2;pane',
      0x07,
      'B',
      0x1b,
      '[?2031h',
      wrapTmuxPassthrough(bytes(0x1b, ']9;task', 0x07)),
      0x1b,
      ']',
      '52;c;aGVsbG8=',
      0x07,
      0x1b,
      ']',
      '133;A',
      ST,
      0x1b,
      'k',
      'echo',
      0x07,
      'C',
      0x1b,
      '[?2031l'
    );
    expectGolden(input, {
      events: [
        { type: 'bell' },
        { type: 'title', title: 'pane' },
        { type: 'theme', subscribed: true },
        { type: 'notification', notification: { source: 'osc9', body: 'task' } },
        { type: 'clipboard', text: 'hello' },
        { type: 'prompt', marker: { kind: 'A', exitCode: null, params: [] } },
        { type: 'title', title: 'echo' },
        { type: 'theme', subscribed: false },
      ],
      output: Array.from(bytes('AB', 0x1b, '[?2031h', 'C', 0x1b, '[?2031l')),
    });
  });
});
