import { describe, expect, test } from 'bun:test';
import {
  SHARE_AUTH_PREFIX,
  SHARE_COOKIE_PREFIX,
  generateShareId,
  generateShareToken,
  hashShareToken,
  isValidShareCookieVia,
  parseShareToken,
  shareCookieName,
} from './share-token';

describe('share token', () => {
  test('shareCookieName 与前缀常量', () => {
    expect(SHARE_COOKIE_PREFIX).toBe('tmex_sh_');
    expect(SHARE_AUTH_PREFIX).toBe('share:');
    expect(shareCookieName('self')).toBe('tmex_sh_self');
    expect(isValidShareCookieVia('self')).toBe(true);
    expect(isValidShareCookieVia('a'.repeat(32))).toBe(true);
    expect(isValidShareCookieVia('bad;name')).toBe(false);
    expect(isValidShareCookieVia('')).toBe(false);
  });

  test('generateShareId 是 22 位 base64url 且不重复', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = generateShareId();
      expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(200);
  });

  test('parseShareToken 拆分 shareId 与随机串，支持 share: 前缀', () => {
    const id = generateShareId();
    const token = generateShareToken(id);
    expect(token.startsWith(`${id}.`)).toBe(true);
    expect(parseShareToken(token)).toEqual({ shareId: id, secret: token.slice(id.length + 1) });
    expect(parseShareToken(`${SHARE_AUTH_PREFIX}${token}`)?.shareId).toBe(id);
  });

  test('畸形 token 返回 null', () => {
    for (const bad of ['', 'nodot', '.secret', `${'a'.repeat(22)}.`, 'short.abc', 'a b.c d']) {
      expect(parseShareToken(bad)).toBeNull();
    }
  });

  test('hashShareToken 是稳定的 SHA-256 十六进制', () => {
    const token = generateShareToken(generateShareId());
    const hash = hashShareToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashShareToken(token)).toBe(hash);
    expect(hashShareToken(`${token}x`)).not.toBe(hash);
  });
});
