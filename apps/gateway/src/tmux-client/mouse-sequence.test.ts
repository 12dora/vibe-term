import { describe, expect, test } from 'bun:test';
import { classifyMouseButton, splitMouseSequences } from './mouse-sequence';

const encode = (text: string) => new TextEncoder().encode(text);
const sgr = (button: number, end = 'M') => `\x1b[<${button};5;7${end}`;
const x10 = (code: number) => `\x1b[M${String.fromCharCode(code + 32, 33 + 4, 33 + 6)}`;
const urxvt = (code: number) => `\x1b[${code + 32};5;7M`;
const kinds = (text: string) => splitMouseSequences(encode(text))?.map((item) => item.kind);

describe('classifyMouseButton', () => {
  test.each([
    [0, 'press'],
    [2, 'press'],
    [16, 'press'],
    [128, 'press'],
    [32, 'drag'],
    [34, 'drag'],
    [48, 'drag'],
    [35, 'hover'],
    [39, 'hover'],
    [43, 'hover'],
    [51, 'hover'],
    [64, 'wheel'],
    [65, 'wheel'],
    [80, 'wheel'],
    [95, 'wheel'],
    [4294967360, 'press'],
  ] as const)('code %i is %s', (code, kind) => {
    expect(classifyMouseButton(code, false)).toBe(kind);
  });
  test('release wins over every code', () => {
    expect(classifyMouseButton(35, true)).toBe('release');
  });
});

describe('splitMouseSequences encodings', () => {
  test('SGR reports keep bytes and kinds', () => {
    expect(kinds(sgr(0) + sgr(0, 'm') + sgr(35) + sgr(32) + sgr(64))).toEqual([
      'press',
      'release',
      'hover',
      'drag',
      'wheel',
    ]);
    expect(splitMouseSequences(encode(sgr(35)))?.[0]?.motionKey).toBe('35:M');
  });

  test('X10 reports are recognised and classified', () => {
    const text = x10(0) + x10(3) + x10(35) + x10(32) + x10(64);
    const sequences = splitMouseSequences(encode(text));
    expect(sequences?.map((item) => item.kind)).toEqual([
      'press',
      'release',
      'hover',
      'drag',
      'wheel',
    ]);
    expect(sequences?.map((item) => new TextDecoder().decode(item.bytes)).join('')).toBe(text);
    expect(sequences?.[4]?.droppable).toBe(true);
  });

  test('urxvt reports are recognised and classified', () => {
    expect(kinds(urxvt(0) + urxvt(3) + urxvt(35) + urxvt(66))).toEqual([
      'press',
      'release',
      'hover',
      'wheel',
    ]);
  });

  test.each([
    '\x1b[M !',
    '\x1b[M\x01!!',
    '\x1b[5;7M',
    '\x1b[12;5;7M',
    '\x1b[1;5A',
    '\x1b[27;5;13~',
    `${x10(0)}k`,
  ])('rejects non-mouse or partial payload %j', (text) => {
    expect(splitMouseSequences(encode(text))).toBeNull();
  });
});
