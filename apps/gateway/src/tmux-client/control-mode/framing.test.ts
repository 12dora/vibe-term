import { describe, expect, test } from 'bun:test';
import { createLineFramer, findByte } from './framing';

const encoder = new TextEncoder();

describe('createLineFramer', () => {
  test('reassembles lines split across chunks and flushes a trailing line on end', () => {
    const lines: string[] = [];
    const decoder = new TextDecoder();
    const framer = createLineFramer((line) => lines.push(decoder.decode(line)));
    const full = encoder.encode('%output %1 hello\n%exit later');
    framer.push(full.subarray(0, 8));
    framer.push(full.subarray(8));
    expect(lines).toEqual(['%output %1 hello']);
    framer.end();
    expect(lines).toEqual(['%output %1 hello', '%exit later']);
  });

  test('findByte scans from an offset', () => {
    const line = encoder.encode('ab cd');
    expect(findByte(line, 0x20, 0)).toBe(2);
    expect(findByte(line, 0x20, 3)).toBe(-1);
  });
});
