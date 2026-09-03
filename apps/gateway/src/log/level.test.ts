import { afterEach, describe, expect, test } from 'bun:test';
import { webhookConfigRefreshLine } from '../events/channels/webhook';
import { debugLine, logLine, warnLine } from '../mesh/mesh-log';
import { rtcLog, rtcLogLevel } from '../mesh/rtc/rtc-log';
import { GatewaySession } from '../ws/gateway-session';
import { logWsClientConnected, logWsClientDisconnected } from '../ws/session-close';
import {
  DEFAULT_LOG_LEVEL,
  type LogLevel,
  getLogLevel,
  logAt,
  parseLogLevel,
  shouldLog,
} from './level';

const LEVEL_KEYS: LogLevel[] = ['error', 'warn', 'info', 'debug'];

function captureLogs(fn: () => void): { error: string[]; warn: string[]; log: string[] } {
  const error: string[] = [];
  const warn: string[] = [];
  const log: string[] = [];
  const origError = console.error;
  const origWarn = console.warn;
  const origLog = console.log;
  const origInfo = console.info;
  console.error = (...args: unknown[]) => {
    error.push(args.map(String).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    warn.push(args.map(String).join(' '));
  };
  console.log = (...args: unknown[]) => {
    log.push(args.map(String).join(' '));
  };
  console.info = (...args: unknown[]) => {
    log.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.error = origError;
    console.warn = origWarn;
    console.log = origLog;
    console.info = origInfo;
  }
  return { error, warn, log };
}

function emitAllLevels(): void {
  logAt('error', 'E');
  logAt('warn', 'W');
  logAt('info', 'I');
  logAt('debug', 'D');
}

function withLogLevel<T>(level: string | undefined, fn: () => T): T {
  const prev = process.env.TMEX_LOG_LEVEL;
  try {
    if (level === undefined) delete process.env.TMEX_LOG_LEVEL;
    else process.env.TMEX_LOG_LEVEL = level;
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TMEX_LOG_LEVEL;
    else process.env.TMEX_LOG_LEVEL = prev;
  }
}

afterEach(() => {
  delete process.env.TMEX_LOG_LEVEL;
});

describe('TMEX_LOG_LEVEL', () => {
  test('parses error|warn|info|debug, defaults to info', () => {
    expect(parseLogLevel(undefined)).toBe(DEFAULT_LOG_LEVEL);
    expect(parseLogLevel('')).toBe('info');
    expect(parseLogLevel('nope')).toBe('info');
    expect(parseLogLevel(' INFO ')).toBe('info');
    expect(parseLogLevel('Debug')).toBe('debug');
    expect(parseLogLevel('WARN')).toBe('warn');
    expect(parseLogLevel('error')).toBe('error');
  });

  test('each configured level emits exactly the expected subset', () => {
    const expected: Record<LogLevel, string[]> = {
      error: ['E'],
      warn: ['E', 'W'],
      info: ['E', 'W', 'I'],
      debug: ['E', 'W', 'I', 'D'],
    };
    for (const level of LEVEL_KEYS) {
      const captured = withLogLevel(level, () => captureLogs(emitAllLevels));
      expect({
        level,
        error: captured.error,
        warn: captured.warn,
        log: captured.log,
      }).toEqual({
        level,
        error: expected[level].includes('E') ? ['E'] : [],
        warn: expected[level].includes('W') ? ['W'] : [],
        log: expected[level].filter((item) => item === 'I' || item === 'D'),
      });
      expect(shouldLog('error', level)).toBe(true);
      expect(shouldLog('debug', level)).toBe(level === 'debug');
    }
  });

  test('unset TMEX_LOG_LEVEL behaves as info', () => {
    const captured = withLogLevel(undefined, () => {
      expect(getLogLevel()).toBe('info');
      return captureLogs(emitAllLevels);
    });
    expect(captured.error).toEqual(['E']);
    expect(captured.warn).toEqual(['W']);
    expect(captured.log).toEqual(['I']);
  });

  test('mesh-log helpers honour the configured level', () => {
    const atError = withLogLevel('error', () =>
      captureLogs(() => {
        logLine('[mesh]', 'info-msg');
        warnLine('[mesh]', 'warn-msg');
        debugLine('[mesh]', 'debug-msg');
      })
    );
    expect(atError.log).toEqual([]);
    expect(atError.warn).toEqual([]);

    const atDebug = withLogLevel('debug', () =>
      captureLogs(() => {
        logLine('[mesh]', 'info-msg');
        warnLine('[mesh]', 'warn-msg');
        debugLine('[mesh]', 'debug-msg');
      })
    );
    expect(atDebug.log.some((line) => line.includes('info-msg'))).toBe(true);
    expect(atDebug.warn.some((line) => line.includes('warn-msg'))).toBe(true);
    expect(atDebug.log.some((line) => line.includes('debug-msg'))).toBe(true);
  });

  test('rtc dial chatter is debug; breaker/dial-failed stay info', () => {
    expect(rtcLogLevel('dial start')).toBe('debug');
    expect(rtcLogLevel('signal send')).toBe('debug');
    expect(rtcLogLevel('signal recv')).toBe('debug');
    expect(rtcLogLevel('signal')).toBe('debug');
    expect(rtcLogLevel('datachannel created')).toBe('debug');
    expect(rtcLogLevel('gathering')).toBe('debug');
    expect(rtcLogLevel('selected pair')).toBe('debug');
    expect(rtcLogLevel('upgrade retry')).toBe('debug');
    expect(rtcLogLevel('datachannel received')).toBe('debug');
    expect(rtcLogLevel('breaker trip')).toBe('info');
    expect(rtcLogLevel('breaker reset')).toBe('info');
    expect(rtcLogLevel('dial failed')).toBe('info');
    expect(rtcLogLevel('ice failed')).toBe('info');
    expect(rtcLogLevel('peer state')).toBe('info');
    expect(rtcLogLevel('datachannel open')).toBe('info');

    const atInfo = withLogLevel('info', () =>
      captureLogs(() => {
        rtcLog('dial start', { peer: 'p' });
        rtcLog('signal send', { peer: 'p', kind: 'sdp' });
        rtcLog('gathering', { peer: 'p', state: 'gathering' });
        rtcLog('breaker trip', { peer: 'p' });
        rtcLog('ice failed', { peer: 'p' });
      })
    );
    expect(atInfo.log.filter((line) => line.includes('[mesh][rtc] dial start'))).toHaveLength(0);
    expect(atInfo.log.filter((line) => line.includes('[mesh][rtc] signal send'))).toHaveLength(0);
    expect(atInfo.log.filter((line) => line.includes('[mesh][rtc] gathering'))).toHaveLength(0);
    expect(atInfo.log.filter((line) => line.includes('[mesh][rtc] breaker trip'))).toHaveLength(1);
    expect(atInfo.log.filter((line) => line.includes('[mesh][rtc] ice failed'))).toHaveLength(1);

    const atDebug = withLogLevel('debug', () =>
      captureLogs(() => {
        rtcLog('dial start', { peer: 'p' });
        rtcLog('signal recv', { peer: 'p', kind: 'sdp' });
      })
    );
    expect(atDebug.log.filter((line) => line.includes('[mesh][rtc] dial start'))).toHaveLength(1);
    expect(atDebug.log.filter((line) => line.includes('[mesh][rtc] signal recv'))).toHaveLength(1);
  });

  test('ws connect is debug; abnormal disconnect is info; normal close is debug', () => {
    const carrier = {
      send: () => 'sent' as const,
      bufferedAmount: () => 0,
      onDrain: () => {},
      close: () => {},
      terminate: () => {},
      logContext: { kind: 'physical_browser_ws' as const, sessionId: 'sess-1' },
    };
    const session = new GatewaySession({ id: 'sess-1', primary: carrier });

    const atInfo = withLogLevel('info', () =>
      captureLogs(() => {
        logWsClientConnected(session);
        logWsClientDisconnected(session, 1000, 'normal');
        logWsClientDisconnected(session, 1006, 'client disconnected');
      })
    );
    expect(atInfo.log.filter((line) => line.includes('[ws] client connected'))).toHaveLength(0);
    expect(
      atInfo.log.filter(
        (line) => line.includes('[ws] client disconnected') && line.includes('code=1000')
      )
    ).toHaveLength(0);
    expect(atInfo.log.filter((line) => line.includes('code=1006'))).toHaveLength(1);
    expect(atInfo.log[0]).toContain('session=sess-1');
    expect(atInfo.log[0]).toContain('carrier=physical_browser_ws');
    expect(atInfo.log[0]).toContain('reason=client disconnected');

    const atDebug = withLogLevel('debug', () =>
      captureLogs(() => {
        logWsClientConnected(session);
        logWsClientDisconnected(session, 1001, 'going away');
      })
    );
    expect(
      atDebug.log.filter((line) => line.includes('[ws] client connected session=sess-1'))
    ).toHaveLength(1);
    expect(atDebug.log.filter((line) => line.includes('code=1001'))).toHaveLength(1);
  });

  test('webhook refresh line is omitted when the count is 0', () => {
    expect(webhookConfigRefreshLine(0)).toBeNull();
    expect(webhookConfigRefreshLine(2)).toBe('[events] refreshed config: 2 webhooks');
  });
});
