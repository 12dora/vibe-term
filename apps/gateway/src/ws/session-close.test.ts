import { describe, expect, test } from 'bun:test';
import { GatewaySession } from './gateway-session';
import { logWsClientDisconnected, sanitizeWsCloseReason } from './session-close';

function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.info;
  const origLog = console.log;
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.info = orig;
    console.log = origLog;
  }
  return lines;
}

describe('sanitizeWsCloseReason', () => {
  test('strips ANSI / C0 controls and caps length', () => {
    expect(sanitizeWsCloseReason('going away')).toBe('going away');
    expect(sanitizeWsCloseReason('a\r\nb')).toBe('ab');
    expect(sanitizeWsCloseReason('cleared\x1b[2Jstill here')).toBe('cleared[2Jstill here');
    expect(sanitizeWsCloseReason('\x1b]0;pwned\x07done')).toBe(']0;pwneddone');
    const long = `tok_${'A'.repeat(80)}`;
    expect(sanitizeWsCloseReason(long).length).toBe(64);
    expect(sanitizeWsCloseReason(long).startsWith('tok_')).toBe(true);
  });
});

describe('logWsClientDisconnected', () => {
  test('persisted disconnect line does not contain control sequences', () => {
    const session = new GatewaySession({
      id: 'sess-1',
      primary: {
        send: () => 'sent' as const,
        bufferedAmount: () => 0,
        onDrain: () => {},
        close: () => {},
        terminate: () => {},
        logContext: { kind: 'physical_browser_ws' as const, sessionId: 'sess-1' },
      },
    });
    const lines = captureLog(() => {
      logWsClientDisconnected(session, 1006, 'bye\x1b[2J\r\nsid=secret-token-value');
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.includes('\x1b')).toBe(false);
    expect(lines[0]?.includes('\r')).toBe(false);
    expect(lines[0]?.includes('\n')).toBe(false);
    expect(lines[0]).toContain('reason=bye[2Jsid=secret-token-value');
  });
});
