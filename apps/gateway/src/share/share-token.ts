import { encodeBase64url, randomBytes, sha256 } from '@tmex/shared/auth';

export const SHARE_COOKIE_PREFIX = 'tmex_sh_';
export const SHARE_AUTH_PREFIX = 'share:';

export const X_TMEX_SET_SHARE = 'x-tmex-set-share';
export const X_TMEX_SET_SHARE_MAX_AGE = 'x-tmex-set-share-max-age';
export const X_TMEX_CLEAR_SHARE = 'x-tmex-clear-share';

export const SHARE_ID_BYTES = 16;
export const SHARE_SECRET_BYTES = 32;
/** 分享凭证寿命上限；永久分享按该值滑动续期。 */
export const SHARE_ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const VIA_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHARE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function shareCookieName(via: string): string {
  return `${SHARE_COOKIE_PREFIX}${via}`;
}

export function isValidShareCookieVia(via: string): boolean {
  return VIA_RE.test(via);
}

export function generateShareId(): string {
  return encodeBase64url(randomBytes(SHARE_ID_BYTES));
}

export function generateShareToken(shareId: string): string {
  return `${shareId}.${encodeBase64url(randomBytes(SHARE_SECRET_BYTES))}`;
}

export function parseShareToken(token: string): { shareId: string; secret: string } | null {
  if (typeof token !== 'string') return null;
  const raw = token.startsWith(SHARE_AUTH_PREFIX) ? token.slice(SHARE_AUTH_PREFIX.length) : token;
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const shareId = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  if (!SHARE_ID_RE.test(shareId) || !SECRET_RE.test(secret)) return null;
  return { shareId, secret };
}

export function hashShareToken(token: string): string {
  const digest = sha256(new TextEncoder().encode(token));
  let out = '';
  for (const byte of digest) out += byte.toString(16).padStart(2, '0');
  return out;
}
