import { describe, expect, test } from 'bun:test';
import { MouseReportingScanner } from './mouse-reporting-scanner';

const encode = (text: string) => new TextEncoder().encode(text);

describe('MouseReportingScanner', () => {
  test('tracking modes replace each other and any reset turns tracking off (tmux semantics)', () => {
    const scanner = new MouseReportingScanner();
    expect(scanner.state.known).toBe(false);
    expect(scanner.push(encode('\x1b[?1000h\x1b[?1003h'))).toBe(false);
    expect(scanner.state).toMatchObject({ known: true, tracking: 'any' });
    expect(scanner.push(encode('\x1b[?1002l'))).toBe(true);
    expect(scanner.state).toMatchObject({ known: true, tracking: 'none' });
  });

  test('combined parameters update tracking and encodings in order', () => {
    const scanner = new MouseReportingScanner();
    scanner.push(encode('\x1b[?1002;1006;1005;1015h'));
    expect(scanner.state).toMatchObject({
      tracking: 'button',
      sgr: true,
      utf8: true,
      urxvt: true,
    });
    expect(scanner.push(encode('\x1b[?1006;1005;1015l'))).toBe(false);
    expect(scanner.state).toMatchObject({ tracking: 'button', sgr: false, utf8: false });
    expect(scanner.push(encode('\x1b[?1003;1006h\x1b[?1000;1006l'))).toBe(true);
    expect(scanner.state).toMatchObject({ tracking: 'none', sgr: false });
  });

  test('a DECSET split across chunks still applies', () => {
    const scanner = new MouseReportingScanner();
    scanner.push(encode('text \x1b[?10'));
    expect(scanner.state.known).toBe(false);
    scanner.push(encode('03;10'));
    scanner.push(encode('06h more'));
    expect(scanner.state).toMatchObject({ known: true, tracking: 'any', sgr: true });
  });

  test('RIS resets every mouse mode; DECSTR only invalidates the known state', () => {
    const scanner = new MouseReportingScanner();
    scanner.push(encode('\x1b[?1003;1006h'));
    scanner.state.verifiedAt = 5;
    expect(scanner.push(encode('\x1b[!p'))).toBe(false);
    expect(scanner.state).toMatchObject({ known: false, verifiedAt: null, tracking: 'any' });
    scanner.push(encode('\x1b[?1003h'));
    expect(scanner.push(encode('\x1b'))).toBe(false);
    expect(scanner.push(encode('c'))).toBe(true);
    expect(scanner.state).toMatchObject({ known: true, tracking: 'none', sgr: false });
  });

  test('alternate screen exit leaves mouse modes alone', () => {
    const scanner = new MouseReportingScanner();
    scanner.push(encode('\x1b[?1049h\x1b[?1003h\x1b[?1049l\x1b[?47l'));
    expect(scanner.state).toMatchObject({ known: true, tracking: 'any' });
  });

  test('tracks DEC 2026 frame end across split chunks and clears it on take', () => {
    const scanner = new MouseReportingScanner();
    expect(scanner.takeFrameEnd()).toBe(false);
    scanner.push(encode('\x1b[?2026h body \x1b[?20'));
    expect(scanner.takeFrameEnd()).toBe(false);
    scanner.push(encode('26l'));
    expect(scanner.takeFrameEnd()).toBe(true);
    expect(scanner.takeFrameEnd()).toBe(false);
    scanner.push(encode('\x1b[?2026;1000l'));
    expect(scanner.takeFrameEnd()).toBe(true);
  });

  test('inFrame follows synchronized-output begin/end', () => {
    const scanner = new MouseReportingScanner();
    expect(scanner.inFrame).toBe(false);
    scanner.push(encode('\x1b[?2026h partial'));
    expect(scanner.inFrame).toBe(true);
    scanner.push(encode('\x1b[?2026l'));
    expect(scanner.inFrame).toBe(false);
  });
});
