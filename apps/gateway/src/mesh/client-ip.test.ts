import { describe, expect, test } from 'bun:test';
import { isRequestLoopback, resolveClientIp } from './client-ip';

const SOCKET = '10.0.0.9';
const LOOPBACK = '127.0.0.1';
const CF_A = '203.0.113.1';
const XFF = '198.51.100.5';
const REAL = '192.0.2.9';

function headers(init?: Record<string, string>): Headers {
  return new Headers(init);
}

describe('resolveClientIp', () => {
  test('untrusted proxy always returns socket IP', () => {
    const h = headers({
      'cf-connecting-ip': CF_A,
      'x-forwarded-for': XFF,
      'x-real-ip': REAL,
    });
    expect(resolveClientIp({ socketIp: SOCKET, headers: h, trustProxy: false })).toBe(SOCKET);
    expect(resolveClientIp({ socketIp: undefined, headers: h, trustProxy: false })).toBeUndefined();
  });

  test('trusted: CF-Connecting-IP wins over X-Forwarded-For and X-Real-IP', () => {
    expect(
      resolveClientIp({
        socketIp: SOCKET,
        headers: headers({
          'cf-connecting-ip': CF_A,
          'x-forwarded-for': XFF,
          'x-real-ip': REAL,
        }),
        trustProxy: true,
      })
    ).toBe(CF_A);
  });

  test('trusted: X-Real-IP wins over X-Forwarded-For when CF is absent', () => {
    expect(
      resolveClientIp({
        socketIp: SOCKET,
        headers: headers({
          'x-forwarded-for': ` ${XFF} , ${CF_A}`,
          'x-real-ip': REAL,
        }),
        trustProxy: true,
      })
    ).toBe(REAL);
  });

  test('trusted: last X-Forwarded-For entry when CF and X-Real-IP are absent', () => {
    expect(
      resolveClientIp({
        socketIp: SOCKET,
        headers: headers({ 'x-forwarded-for': '1.2.3.4, 10.0.0.9' }),
        trustProxy: true,
      })
    ).toBe('10.0.0.9');
  });

  test('trusted: skips empty X-Forwarded-For entries from the end', () => {
    expect(
      resolveClientIp({
        socketIp: SOCKET,
        headers: headers({ 'x-forwarded-for': ` ${XFF} ,  ` }),
        trustProxy: true,
      })
    ).toBe(XFF);
  });

  test('trusted: invalid last X-Forwarded-For entry does not fall back to earlier ones', () => {
    expect(
      resolveClientIp({
        socketIp: SOCKET,
        headers: headers({ 'x-forwarded-for': '1.2.3.4, not-an-ip' }),
        trustProxy: true,
      })
    ).toBe(SOCKET);
  });

  test('trusted: X-Real-IP when CF and XFF are absent', () => {
    expect(
      resolveClientIp({
        socketIp: SOCKET,
        headers: headers({ 'x-real-ip': REAL }),
        trustProxy: true,
      })
    ).toBe(REAL);
  });

  test('trusted: malformed forwarded values fall back to socket IP', () => {
    expect(
      resolveClientIp({
        socketIp: SOCKET,
        headers: headers({
          'cf-connecting-ip': 'not-an-ip',
          'x-forwarded-for': 'unknown, also-bad',
          'x-real-ip': '999.999.999.999',
        }),
        trustProxy: true,
      })
    ).toBe(SOCKET);
  });

  test('trusted: garbage CF is skipped in favour of a valid later header', () => {
    expect(
      resolveClientIp({
        socketIp: SOCKET,
        headers: headers({
          'cf-connecting-ip': 'nope',
          'x-forwarded-for': XFF,
        }),
        trustProxy: true,
      })
    ).toBe(XFF);
  });

  test('trusted: IPv6 literals including bracketed and mapped forms', () => {
    expect(
      resolveClientIp({
        socketIp: SOCKET,
        headers: headers({ 'cf-connecting-ip': '2001:db8::1' }),
        trustProxy: true,
      })
    ).toBe('2001:db8::1');
    expect(
      resolveClientIp({
        socketIp: SOCKET,
        headers: headers({ 'x-forwarded-for': '[2001:db8::2]' }),
        trustProxy: true,
      })
    ).toBe('2001:db8::2');
    expect(
      resolveClientIp({
        socketIp: SOCKET,
        headers: headers({ 'x-real-ip': '::ffff:203.0.113.5' }),
        trustProxy: true,
      })
    ).toBe('::ffff:203.0.113.5');
    expect(
      resolveClientIp({
        socketIp: SOCKET,
        headers: headers({ 'cf-connecting-ip': '::1' }),
        trustProxy: true,
      })
    ).toBe('::1');
  });
});

describe('isRequestLoopback', () => {
  test('(a) loopback socket and no proxy headers is loopback', () => {
    expect(isRequestLoopback({ socketIp: LOOPBACK, headers: headers(), trustProxy: false })).toBe(
      true
    );
    expect(isRequestLoopback({ socketIp: LOOPBACK, headers: headers(), trustProxy: true })).toBe(
      true
    );
  });

  test('(b) CF-Connecting-IP is never loopback, regardless of trustProxy', () => {
    const h = headers({ 'cf-connecting-ip': '203.0.113.5' });
    expect(isRequestLoopback({ socketIp: LOOPBACK, headers: h, trustProxy: false })).toBe(false);
    expect(isRequestLoopback({ socketIp: LOOPBACK, headers: h, trustProxy: true })).toBe(false);
    for (const value of ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'not-an-ip']) {
      const forged = headers({ 'cf-connecting-ip': value });
      expect(isRequestLoopback({ socketIp: LOOPBACK, headers: forged, trustProxy: true })).toBe(
        false
      );
      expect(isRequestLoopback({ socketIp: LOOPBACK, headers: forged, trustProxy: false })).toBe(
        false
      );
    }
  });

  test('(c) trustProxy + X-Forwarded-For uses the forwarded IP', () => {
    expect(
      isRequestLoopback({
        socketIp: LOOPBACK,
        headers: headers({ 'x-forwarded-for': '203.0.113.5' }),
        trustProxy: true,
      })
    ).toBe(false);
  });

  test('(d) untrusted X-Forwarded-For only keeps socket loopback behaviour', () => {
    expect(
      isRequestLoopback({
        socketIp: LOOPBACK,
        headers: headers({ 'x-forwarded-for': '203.0.113.5' }),
        trustProxy: false,
      })
    ).toBe(true);
  });
});
