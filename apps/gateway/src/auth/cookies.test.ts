import { describe, expect, test } from 'bun:test';
import { LinkError } from '@vibeterm/shared/link';
import { PeerHandshakeError } from '../mesh/types';
import {
  appendNodeSessionCookie,
  buildClearCookie,
  buildSetCookie,
  clearNodeSessionCookie,
  formatSafeErrorLog,
  hasNodeSessionCookie,
  isCanonicalNodeId,
  legacyNodeSessionCookieName,
  nodeSessionCookieName,
  parseCookies,
  readNodeSessionCookie,
} from './cookies';

describe('parseCookies', () => {
  test('returns empty map for missing or empty header', () => {
    expect(parseCookies(undefined).size).toBe(0);
    expect(parseCookies(null).size).toBe(0);
    expect(parseCookies('').size).toBe(0);
  });

  test('parses name/value pairs and keeps values that contain =', () => {
    const cookies = parseCookies('vibeterm_s_self=abc; other=x=y;  spaced = z ');
    expect(cookies.get('vibeterm_s_self')).toBe('abc');
    expect(cookies.get('other')).toBe('x=y');
    expect(cookies.get('spaced')).toBe('z');
  });

  test('last duplicate name wins', () => {
    expect(parseCookies('a=1; a=2').get('a')).toBe('2');
  });
});

describe('nodeSessionCookieName', () => {
  test('prefixes vibeterm_s_ 并保留 tmex_s_ 旧名', () => {
    expect(nodeSessionCookieName('self')).toBe('vibeterm_s_self');
    expect(nodeSessionCookieName('node-abc')).toBe('vibeterm_s_node-abc');
    expect(legacyNodeSessionCookieName('self')).toBe('tmex_s_self');
    expect(readNodeSessionCookie(parseCookies('tmex_s_self=old'), 'self')).toBe('old');
    expect(
      readNodeSessionCookie(parseCookies('tmex_s_self=old; vibeterm_s_self=new'), 'self')
    ).toBe('new');
    expect(hasNodeSessionCookie(parseCookies('tmex_s_self=old'), 'self')).toBe(true);
    expect(hasNodeSessionCookie(parseCookies('x=1'), 'self')).toBe(false);
  });
});

describe('isCanonicalNodeId', () => {
  test('accepts lowercase 32-hex and rejects everything else', () => {
    expect(isCanonicalNodeId('bb'.repeat(16))).toBe(true);
    expect(isCanonicalNodeId('BB'.repeat(16))).toBe(false);
    expect(isCanonicalNodeId('deadbeef')).toBe(false);
    expect(isCanonicalNodeId('self')).toBe(false);
    expect(isCanonicalNodeId('self=')).toBe(false);
    expect(isCanonicalNodeId('aa;evil')).toBe(false);
    expect(isCanonicalNodeId('aa\r\nbb')).toBe(false);
  });
});

describe('buildSetCookie / buildClearCookie', () => {
  test('formats Path/HttpOnly/SameSite/Max-Age without Secure', () => {
    expect(buildSetCookie('vibeterm_s_self', 'sidvalue', { maxAgeSec: 64800, secure: false })).toBe(
      'vibeterm_s_self=sidvalue; Path=/; HttpOnly; SameSite=Lax; Max-Age=64800'
    );
  });

  test('appends Secure when requested', () => {
    expect(buildSetCookie('vibeterm_s_self', 'sidvalue', { maxAgeSec: 64800, secure: true })).toBe(
      'vibeterm_s_self=sidvalue; Path=/; HttpOnly; SameSite=Lax; Max-Age=64800; Secure'
    );
  });

  test('clear cookie expires immediately', () => {
    expect(buildClearCookie('vibeterm_s_self')).toBe(
      'vibeterm_s_self=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
    );
  });

  test('clear cookie appends Secure when requested', () => {
    expect(buildClearCookie('vibeterm_s_self', { secure: true })).toBe(
      'vibeterm_s_self=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure'
    );
  });
});

describe('appendNodeSessionCookie / clearNodeSessionCookie', () => {
  test('emits Set-Cookie only for canonical 32-hex node ids', () => {
    const ok = new Headers();
    appendNodeSessionCookie(ok, 'aa'.repeat(16), 'sid', { maxAgeSec: 60, secure: false });
    clearNodeSessionCookie(ok, 'bb'.repeat(16), { secure: false });
    const cookies = ok.getSetCookie();
    expect(cookies.some((c) => c.startsWith(`vibeterm_s_${'aa'.repeat(16)}=`))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`vibeterm_s_${'bb'.repeat(16)}=`))).toBe(true);
    // 混合版本桥：旧名同时下发/清除
    expect(cookies.some((c) => c.startsWith(`tmex_s_${'aa'.repeat(16)}=`))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`tmex_s_${'bb'.repeat(16)}=`))).toBe(true);

    const bad = new Headers();
    appendNodeSessionCookie(bad, 'self=', 'sid', { maxAgeSec: 60, secure: false });
    clearNodeSessionCookie(bad, 'self=', { secure: false });
    clearNodeSessionCookie(bad, 'BB'.repeat(16));
    clearNodeSessionCookie(bad, 'aa;vibeterm_s_self');
    expect(bad.getSetCookie()).toEqual([]);
  });
});

describe('formatSafeErrorLog', () => {
  test('whitelists handshake/link codes and strips C0/C1 from the summary', () => {
    const injected = 'hello \u001b[31mevil\u0007\u009bRST';
    expect(formatSafeErrorLog(new PeerHandshakeError('protocol', injected))).toBe(
      'reason=protocol summary=hello [31mevilRST'
    );
    expect(formatSafeErrorLog(new LinkError('rst', injected))).toBe(
      'reason=rst summary=hello [31mevilRST'
    );
    expect(formatSafeErrorLog(new Error(injected))).toBe(
      'reason=unknown summary=hello [31mevilRST'
    );
    const long = `x${'y'.repeat(200)}`;
    const formatted = formatSafeErrorLog(new LinkError('rst', long));
    expect(formatted.startsWith('reason=rst summary=')).toBe(true);
    expect(formatted.slice('reason=rst summary='.length).length).toBe(120);
  });
});
