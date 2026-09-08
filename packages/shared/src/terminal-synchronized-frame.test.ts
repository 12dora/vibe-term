import { describe, expect, test } from 'bun:test';
import { endsSynchronizedFrame } from './terminal-synchronized-frame';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('endsSynchronizedFrame', () => {
  test('detects the DEC 2026 end sequence inside one segment', () => {
    expect(
      endsSynchronizedFrame(undefined, bytes('\x1b[?2026h frame \x1b[?2026l\x1b[?1000h'))
    ).toBe(true);
    expect(endsSynchronizedFrame(undefined, bytes('\x1b[?2026h frame'))).toBe(false);
    expect(endsSynchronizedFrame(undefined, bytes('\x1b[?2026h'))).toBe(false);
    expect(endsSynchronizedFrame(undefined, bytes(''))).toBe(false);
  });

  test('detects a sequence split across the previous segment tail and the new head', () => {
    expect(endsSynchronizedFrame(bytes('frame \x1b[?20'), bytes('26l'))).toBe(true);
    expect(endsSynchronizedFrame(bytes('frame \x1b'), bytes('[?2026l'))).toBe(true);
    expect(endsSynchronizedFrame(bytes('frame \x1b[?2026'), bytes('h'))).toBe(false);
    expect(endsSynchronizedFrame(bytes('\x1b[?2026l'), bytes('tail'))).toBe(false);
  });
});
