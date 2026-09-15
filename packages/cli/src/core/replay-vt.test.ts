import { describe, expect, test } from 'bun:test';
import { REPLAY_TTY_RESTORE, ReplayVtFilter } from './replay-vt';

function enc(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function dec(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function pushAll(filter: ReplayVtFilter, chunks: string[]): string {
  return chunks.map((chunk) => dec(filter.push(enc(chunk)))).join('');
}

describe('ReplayVtFilter', () => {
  test('keeps SGR, cursor, erase and alt-screen', () => {
    const filter = new ReplayVtFilter();
    const input = '\x1b[31mhi\x1b[0m\x1b[2J\x1b[H\x1b[?1049h';
    expect(dec(filter.push(enc(input)))).toBe(input);
    expect(filter.needsRestore()).toBe(true);
  });

  test('strips OSC 52 even when split across chunks', () => {
    const filter = new ReplayVtFilter();
    expect(pushAll(filter, ['hi\x1b]52;c;', 'QUFBQQ==\x07lo'])).toBe('hilo');
  });

  test('keeps OSC 0/1/2 title sequences across a split', () => {
    const filter = new ReplayVtFilter();
    expect(pushAll(filter, ['\x1b]0;', 'title\x07'])).toBe('\x1b]0;title\x07');
    expect(pushAll(filter, ['\x1b]2;x\x1b', '\\'])).toBe('\x1b]2;x\x1b\\');
  });

  test('strips CSI device-status and DA queries across splits', () => {
    const filter = new ReplayVtFilter();
    expect(pushAll(filter, ['a\x1b[6', 'nb\x1b[', 'c'])).toBe('ab');
    expect(pushAll(filter, ['\x1b[>c', 'x\x1b[?25$p'])).toBe('x');
  });

  test('strips DCS / APC / PM / SOS strings', () => {
    const filter = new ReplayVtFilter();
    expect(pushAll(filter, ['\x1bPsecret\x1b\\ok'])).toBe('ok');
    expect(pushAll(filter, ['\x1b_apc\x07', '\x1b^pm\x1b\\', '\x1bXsos\x1b\\done'])).toBe('done');
  });

  test('DCS split across the ST boundary is dropped', () => {
    const filter = new ReplayVtFilter();
    expect(pushAll(filter, ['\x1bPsec', 'ret\x1b', '\\tail'])).toBe('tail');
  });

  test('tracks mouse, cursor-hide and bracketed-paste for restore', () => {
    const filter = new ReplayVtFilter();
    filter.push(enc('\x1b[?25l\x1b[?1000h\x1b[?2004h'));
    expect(filter.needsRestore()).toBe(true);
    expect(dec(filter.restoreBytes())).toBe(REPLAY_TTY_RESTORE);
  });

  test('plain text does not need restore; incomplete ESC is dropped on flush', () => {
    const filter = new ReplayVtFilter();
    expect(dec(filter.push(enc('hello\x1b')))).toBe('hello');
    expect(filter.needsRestore()).toBe(false);
    expect(filter.flush().byteLength).toBe(0);
    expect(dec(filter.push(enc('[31m')))).toBe('[31m');
  });
});
