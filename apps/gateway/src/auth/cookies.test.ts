import { describe, expect, test } from 'bun:test';
import { buildClearCookie, buildSetCookie, nodeSessionCookieName, parseCookies } from './cookies';

describe('parseCookies', () => {
  test('returns empty map for missing or empty header', () => {
    expect(parseCookies(undefined).size).toBe(0);
    expect(parseCookies(null).size).toBe(0);
    expect(parseCookies('').size).toBe(0);
  });

  test('parses name/value pairs and keeps values that contain =', () => {
    const cookies = parseCookies('tmex_s_self=abc; other=x=y;  spaced = z ');
    expect(cookies.get('tmex_s_self')).toBe('abc');
    expect(cookies.get('other')).toBe('x=y');
    expect(cookies.get('spaced')).toBe('z');
  });

  test('last duplicate name wins', () => {
    expect(parseCookies('a=1; a=2').get('a')).toBe('2');
  });
});

describe('nodeSessionCookieName', () => {
  test('prefixes tmex_s_ and uses self for the local node', () => {
    expect(nodeSessionCookieName('self')).toBe('tmex_s_self');
    expect(nodeSessionCookieName('node-abc')).toBe('tmex_s_node-abc');
  });
});

describe('buildSetCookie / buildClearCookie', () => {
  test('formats Path/HttpOnly/SameSite/Max-Age without Secure', () => {
    expect(buildSetCookie('tmex_s_self', 'sidvalue', { maxAgeSec: 64800, secure: false })).toBe(
      'tmex_s_self=sidvalue; Path=/; HttpOnly; SameSite=Lax; Max-Age=64800'
    );
  });

  test('appends Secure when requested', () => {
    expect(buildSetCookie('tmex_s_self', 'sidvalue', { maxAgeSec: 64800, secure: true })).toBe(
      'tmex_s_self=sidvalue; Path=/; HttpOnly; SameSite=Lax; Max-Age=64800; Secure'
    );
  });

  test('clear cookie expires immediately', () => {
    expect(buildClearCookie('tmex_s_self')).toBe(
      'tmex_s_self=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
    );
  });

  test('clear cookie appends Secure when requested', () => {
    expect(buildClearCookie('tmex_s_self', { secure: true })).toBe(
      'tmex_s_self=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure'
    );
  });
});
