import { describe, expect, test } from 'bun:test';
import { MouseReportingScanner } from './mouse-reporting-scanner';

const encode = (text: string) => new TextEncoder().encode(text);

describe('MouseReportingScanner', () => {
  test('reports a reporting reset only when every reporting mode is off', () => {
    const scanner = new MouseReportingScanner();
    expect(scanner.push(encode('\x1b[?1000h\x1b[?1002h'))).toBe(false);
    expect(scanner.push(encode('\x1b[?1000l'))).toBe(false);
    expect(scanner.push(encode('\x1b[?1002l'))).toBe(true);
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
