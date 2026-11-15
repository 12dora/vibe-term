import { describe, expect, test } from 'bun:test';
import { MouseTrackingScanner } from './mouse-tracking-scanner';

const encoder = new TextEncoder();

describe('MouseTrackingScanner', () => {
  test('DECSET / DECRST 的鼠标跟踪模式给出净效果', () => {
    const scanner = new MouseTrackingScanner();

    expect(scanner.feed('\x1b[?1003h')).toEqual({ mode: 1003, enabled: true });
    expect(scanner.feed('\x1b[?1003l')).toEqual({ mode: 1003, enabled: false });
    expect(scanner.feed('\x1b[?1000l')).toEqual({ mode: 1000, enabled: false });
    expect(scanner.feed('\x1b[?1002h')).toEqual({ mode: 1002, enabled: true });
  });

  test('1006 / 1049 等非跟踪模式与普通文本不产生变化', () => {
    const scanner = new MouseTrackingScanner();

    expect(scanner.feed('\x1b[?1006l')).toBeNull();
    expect(scanner.feed('\x1b[?1049h\x1b[?25l')).toBeNull();
    expect(scanner.feed('plain 1000 1003 text')).toBeNull();
    expect(scanner.feed('\x1b[1000h')).toBeNull();
  });

  test('同一段输出里以最后一个跟踪模式参数为准', () => {
    const scanner = new MouseTrackingScanner();

    expect(scanner.feed('\x1b[?1003h\x1b[?1000l')).toEqual({ mode: 1000, enabled: false });
    expect(scanner.feed('\x1b[?1000h\x1b[?1003h')).toEqual({ mode: 1003, enabled: true });
    expect(scanner.feed('\x1b[?1000;1002;1003l')).toEqual({ mode: 1003, enabled: false });
    expect(scanner.feed('\x1b[?1006;1003h')).toEqual({ mode: 1003, enabled: true });
  });

  test('序列被拆在两段输出之间仍能识别', () => {
    const scanner = new MouseTrackingScanner();

    expect(scanner.feed('abc\x1b[?10')).toBeNull();
    expect(scanner.feed('03')).toBeNull();
    expect(scanner.feed('l tail')).toEqual({ mode: 1003, enabled: false });

    expect(scanner.feed('\x1b')).toBeNull();
    expect(scanner.feed('[?1000h')).toEqual({ mode: 1000, enabled: true });
  });

  test('接受 Uint8Array，被打断的序列不残留状态', () => {
    const scanner = new MouseTrackingScanner();

    expect(scanner.feed(encoder.encode('\x1b[?1003h'))).toEqual({ mode: 1003, enabled: true });
    expect(scanner.feed('\x1b[?10x03l')).toBeNull();
    expect(scanner.feed('\x1b[?1000\x1b[?1002l')).toEqual({ mode: 1002, enabled: false });
  });

  test('reset 丢弃半截序列', () => {
    const scanner = new MouseTrackingScanner();

    scanner.feed('\x1b[?100');
    scanner.reset();

    expect(scanner.feed('3h')).toBeNull();
  });
});
