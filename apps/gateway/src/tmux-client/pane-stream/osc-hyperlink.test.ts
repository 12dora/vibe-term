import { describe, expect, test } from 'bun:test';

import { createPaneStreamParser } from '../pane-stream-parser';
import { MAX_OSC_HYPERLINK_PARAMS_BYTES, MAX_OSC_HYPERLINK_URI_BYTES } from './parser-state';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ESC = '\x1b';

function createParser() {
  const notifications: unknown[] = [];
  const titles: string[] = [];
  const parser = createPaneStreamParser({
    onTitle: (title) => titles.push(title),
    onBell: () => {},
    onNotification: (notification) => notifications.push(notification),
  });
  return { parser, notifications, titles };
}

function pushText(parser: ReturnType<typeof createParser>['parser'], text: string): string {
  return decoder.decode(parser.push(encoder.encode(text)).slice());
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

function pushSplit(data: Uint8Array, split: number): string {
  const { parser } = createParser();
  const first = parser.push(data.slice(0, split)).slice();
  const second = parser.push(data.slice(split)).slice();
  return decoder.decode(concat([first, second]));
}

const OPEN_ST = `${ESC}]8;id=a1;https://example.com/a/b${ESC}\\`;
const CLOSE_ST = `${ESC}]8;;${ESC}\\`;

describe('pane stream parser - OSC 8 hyperlinks', () => {
  test('forwards open and close sequences with surrounding text', () => {
    const { parser } = createParser();
    const input = `pre ${OPEN_ST}label${CLOSE_ST} post`;
    expect(pushText(parser, input)).toBe(input);
  });

  test('forwards empty params and the exact close form', () => {
    const { parser } = createParser();
    expect(pushText(parser, `${ESC}]8;;https://example.com${ESC}\\x${CLOSE_ST}`)).toBe(
      `${ESC}]8;;https://example.com${ESC}\\x${CLOSE_ST}`
    );
    expect(pushText(parser, CLOSE_ST)).toBe(CLOSE_ST);
  });

  test('normalises BEL terminator to ST', () => {
    const { parser } = createParser();
    const output = pushText(parser, `${ESC}]8;id=a1;https://example.com\x07label${ESC}]8;;\x07`);
    expect(output).toBe(`${ESC}]8;id=a1;https://example.com${ESC}\\label${CLOSE_ST}`);
  });

  test('keeps non-ASCII URI bytes intact', () => {
    const { parser } = createParser();
    const input = `${ESC}]8;;file:///work/中文%20目录/a.ts${ESC}\\`;
    expect(pushText(parser, input)).toBe(input);
  });

  test('does not emit notifications or titles for OSC 8', () => {
    const { parser, notifications, titles } = createParser();
    pushText(parser, `${OPEN_ST}x${CLOSE_ST}`);
    expect(notifications).toEqual([]);
    expect(titles).toEqual([]);
  });

  test('is byte-faithful when split at every byte boundary', () => {
    const sample = `A${OPEN_ST}link text${CLOSE_ST}B${ESC}]8;;https://example.com/x\x07C${CLOSE_ST}`;
    const expectedOutput = `A${OPEN_ST}link text${CLOSE_ST}B${ESC}]8;;https://example.com/x${ESC}\\C${CLOSE_ST}`;
    const data = encoder.encode(sample);
    expect(pushText(createParser().parser, sample)).toBe(expectedOutput);
    for (let split = 0; split <= data.length; split += 1) {
      expect(pushSplit(data, split)).toBe(expectedOutput);
    }
    const { parser } = createParser();
    const chunks = Array.from(data, (byte) => parser.push(new Uint8Array([byte])).slice());
    expect(decoder.decode(concat(chunks))).toBe(expectedOutput);
  });

  test('forwards a URI at the cap and replaces one byte over with a close', () => {
    const prefix = 'https://example.com/';
    const atCap = `${prefix}${'a'.repeat(MAX_OSC_HYPERLINK_URI_BYTES - prefix.length)}`;
    const { parser } = createParser();
    expect(pushText(parser, `${ESC}]8;;${atCap}${ESC}\\x`)).toBe(`${ESC}]8;;${atCap}${ESC}\\x`);
    expect(pushText(parser, `${ESC}]8;;${atCap}a${ESC}\\x`)).toBe(`${CLOSE_ST}x`);
  });

  test('overlong URI is replaced by a close; following text and later links survive', () => {
    const { parser } = createParser();
    const longUri = `https://example.com/${'a'.repeat(5000)}`;
    const output = pushText(parser, `A${ESC}]8;;${longUri}${ESC}\\B${OPEN_ST}C${CLOSE_ST}`);
    expect(output).toBe(`A${CLOSE_ST}B${OPEN_ST}C${CLOSE_ST}`);
  });

  test('payload beyond the generic OSC limit emits one close, then recovers', () => {
    const { parser } = createParser();
    const huge = `https://example.com/${'a'.repeat(20 * 1024)}`;
    const output = pushText(parser, `A${ESC}]8;;${huge}\x07B${OPEN_ST}C`);
    expect(output).toBe(`A${CLOSE_ST}B${OPEN_ST}C`);
  });

  test('generic-limit overflow ended by ST (and ESC inside the ignored body) emits one close', () => {
    const { parser } = createParser();
    const huge = `https://example.com/${'a'.repeat(20 * 1024)}`;
    const output = pushText(parser, `A${ESC}]8;;${huge}${ESC}[0m${huge}${ESC}\\B`);
    expect(output).toBe(`A${CLOSE_ST}B`);
  });

  test('a link left open is closed when the next OSC 8 is dropped', () => {
    const { parser } = createParser();
    const longUri = `https://example.com/${'a'.repeat(5000)}`;
    const output = pushText(parser, `${OPEN_ST}LinkA${ESC}]8;;${longUri}${ESC}\\LinkB`);
    expect(output).toBe(`${OPEN_ST}LinkA${CLOSE_ST}LinkB`);
  });

  test('overlong params are replaced by a close', () => {
    const { parser } = createParser();
    const params = `id=${'x'.repeat(MAX_OSC_HYPERLINK_PARAMS_BYTES)}`;
    expect(pushText(parser, `${ESC}]8;${params};https://example.com${ESC}\\Z`)).toBe(
      `${CLOSE_ST}Z`
    );
  });

  test('dropped overlong URI split at every byte boundary emits exactly one close', () => {
    const longUri = `https://example.com/${'a'.repeat(5000)}`;
    const data = encoder.encode(`A${ESC}]8;;${longUri}${ESC}\\B`);
    const stride = 97;
    for (let split = 0; split <= data.length; split += stride) {
      expect(pushSplit(data, split)).toBe(`A${CLOSE_ST}B`);
    }
    for (const split of [1, 2, 3, 4, 5, 6, 7, data.length - 3, data.length - 2, data.length - 1]) {
      expect(pushSplit(data, split)).toBe(`A${CLOSE_ST}B`);
    }
  });

  test('generic-limit overflow split across pushes emits exactly one close', () => {
    const { parser } = createParser();
    const huge = `https://example.com/${'a'.repeat(20 * 1024)}`;
    const outputs = [
      pushText(parser, `A${ESC}]8;;${huge.slice(0, 10 * 1024)}`),
      pushText(parser, huge.slice(10 * 1024)),
      pushText(parser, `${ESC}`),
      pushText(parser, '\\B'),
    ];
    expect(outputs.join('')).toBe(`A${CLOSE_ST}B`);
  });

  test('malformed payloads without a params separator are replaced by a close', () => {
    const { parser } = createParser();
    expect(pushText(parser, `A${ESC}]8${ESC}\\B`)).toBe(`A${CLOSE_ST}B`);
    expect(pushText(parser, `A${ESC}]8;noseparator${ESC}\\B`)).toBe(`A${CLOSE_ST}B`);
  });

  test('payloads carrying control bytes are replaced by a close, never re-emitted', () => {
    const { parser } = createParser();
    const output = pushText(parser, `A${ESC}]8;;https://example.com/${ESC}[31mred\x07B`);
    expect(output).toBe(`A${CLOSE_ST}B`);
  });

  test('forwards OSC 8 unwrapped from tmux DCS passthrough', () => {
    const { parser } = createParser();
    const inner = `${ESC}]8;;https://example.com${ESC}\\link${CLOSE_ST}`;
    const wrapped = `${ESC}Ptmux;${inner.replaceAll(ESC, ESC + ESC)}${ESC}\\`;
    expect(pushText(parser, `A${wrapped}B`)).toBe(`A${inner}B`);
  });

  test('forwards passthrough-wrapped OSC 8 split across pushes', () => {
    const inner = `${ESC}]8;;https://example.com${ESC}\\link${CLOSE_ST}`;
    const wrapped = `A${ESC}Ptmux;${inner.replaceAll(ESC, ESC + ESC)}${ESC}\\B`;
    const data = encoder.encode(wrapped);
    for (let split = 0; split <= data.length; split += 1) {
      expect(pushSplit(data, split)).toBe(`A${inner}B`);
    }
  });

  test('still swallows other unknown OSC kinds, including 80-89 lookalikes', () => {
    const { parser } = createParser();
    expect(pushText(parser, `A${ESC}]999;secret\x07B`)).toBe('AB');
    expect(pushText(parser, `A${ESC}]88;x;y${ESC}\\B`)).toBe('AB');
    expect(pushText(parser, `A${ESC}]80;x;y\x07B`)).toBe('AB');
    expect(pushText(parser, `A${ESC}]4;1;rgb:ff/00/00\x07B`)).toBe('AB');
  });

  test('does not write output when the caller skips materialisation', () => {
    const { parser } = createParser();
    expect(parser.push(encoder.encode(OPEN_ST), false).length).toBe(0);
    expect(pushText(parser, 'x')).toBe('x');
  });
});
