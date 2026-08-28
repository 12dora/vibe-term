import { describe, expect, test } from 'bun:test';
import { totpOtpauthUri } from '../../../packages/app/src/lib/totp-uri.ts';
import { decodeBase64url, totpCode } from '../../../packages/shared/src/auth/index.ts';
import { decodeBase32, parseOtpauthSecret, resolveTotpCode, totpLoginField } from './totp.ts';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const RFC6238_ASCII = '12345678901234567890';
const RFC6238_SECRET = new TextEncoder().encode(RFC6238_ASCII);
const RFC6238_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('decodeBase32', () => {
  test('RFC 4648 unpadded vectors', () => {
    const utf8 = (s: string) => new TextDecoder().decode(decodeBase32(s));
    expect(utf8('MY')).toBe('f');
    expect(utf8('MZXQ')).toBe('fo');
    expect(utf8('MZXW6')).toBe('foo');
    expect(utf8('MZXW6YQ')).toBe('foob');
    expect(utf8('MZXW6YTB')).toBe('fooba');
    expect(utf8('MZXW6YTBOI')).toBe('foobar');
  });

  test('strips padding and accepts lowercase', () => {
    expect(new TextDecoder().decode(decodeBase32('MZXW6==='))).toBe('foo');
    expect(new TextDecoder().decode(decodeBase32('mzxw6'))).toBe('foo');
  });

  test('decodes RFC 6238 SHA-1 secret', () => {
    expect(new TextDecoder().decode(decodeBase32(RFC6238_BASE32))).toBe(RFC6238_ASCII);
  });

  test('rejects invalid alphabet', () => {
    expect(() => decodeBase32('MZXW1')).toThrow(/invalid base32/);
  });
});

describe('parseOtpauthSecret', () => {
  test('extracts secret from hub user totp URI', () => {
    const uri =
      'otpauth://totp/tmex%3Aalice?secret=JBSWY3DPEHPK3PXP&issuer=tmex&algorithm=SHA1&digits=6&period=30';
    expect(parseOtpauthSecret(uri)).toBe('JBSWY3DPEHPK3PXP');
  });

  test('round-trips CLI totpOtpauthUri secret bytes', () => {
    const secret = new Uint8Array(20).fill(7);
    const uri = totpOtpauthUri('alice', secret);
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    const decoded = decodeBase32(parseOtpauthSecret(uri));
    expect(Array.from(decoded)).toEqual(Array.from(secret));
  });

  test('rejects missing secret', () => {
    expect(() => parseOtpauthSecret('otpauth://totp/tmex:alice?issuer=tmex')).toThrow(/secret/);
  });
});

describe('resolveTotpCode', () => {
  test('--totp wins over env and secret', () => {
    expect(
      resolveTotpCode({
        totp: '111111',
        totpSecret: RFC6238_BASE32,
        envTotp: '222222',
        nowSec: 59,
      })
    ).toBe('111111');
  });

  test('TMEX_TOTP wins over --totp-secret', () => {
    expect(
      resolveTotpCode({
        totpSecret: RFC6238_BASE32,
        envTotp: '222222',
        nowSec: 59,
      })
    ).toBe('222222');
  });

  test('--totp-secret computes current 6-digit code', () => {
    const code = resolveTotpCode({ totpSecret: RFC6238_BASE32, nowSec: 59 });
    expect(code).toBe(totpCode(RFC6238_SECRET, 59));
    expect(code).toBe('287082');
  });

  test('returns undefined when nothing is provided', () => {
    expect(resolveTotpCode({})).toBeUndefined();
  });
});

describe('totpLoginField', () => {
  test('attaches k_totp derived from seed', () => {
    const seed = new Uint8Array(32).fill(0x11);
    const field = totpLoginField(seed, 'user-1', 0, '123456');
    expect(field.code).toBe('123456');
    expect(bytesToHex(decodeBase64url(field.k_totp))).toBe(
      'f5104f9232dae1a6b6d3a5b60b6263e8a55edf41484e66c7992a451555318e06'
    );
  });
});
