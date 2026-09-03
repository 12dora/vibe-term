import { describe, expect, test } from 'bun:test';
import { encodeBase32, fingerprintPublicKey, totpOtpauthUri } from './totp-uri';

describe('encodeBase32 RFC 4648', () => {
  test('vectors without padding', () => {
    const utf8 = (s: string) => new TextEncoder().encode(s);
    expect(encodeBase32(utf8(''))).toBe('');
    expect(encodeBase32(utf8('f'))).toBe('MY');
    expect(encodeBase32(utf8('fo'))).toBe('MZXQ');
    expect(encodeBase32(utf8('foo'))).toBe('MZXW6');
    expect(encodeBase32(utf8('foob'))).toBe('MZXW6YQ');
    expect(encodeBase32(utf8('fooba'))).toBe('MZXW6YTB');
    expect(encodeBase32(utf8('foobar'))).toBe('MZXW6YTBOI');
  });
});

describe('totpOtpauthUri', () => {
  test('builds Key Uri Format with SHA1 / 6 digits / 30s', () => {
    const uri = totpOtpauthUri('alice', new TextEncoder().encode('foobar'));
    expect(uri).toBe(
      'otpauth://totp/tmex%3Aalice?secret=MZXW6YTBOI&issuer=tmex&algorithm=SHA1&digits=6&period=30'
    );
  });

  test('encodes a custom issuer in both label and query', () => {
    const uri = totpOtpauthUri('bob', new TextEncoder().encode('f'), 'Example Corp');
    expect(uri).toBe(
      'otpauth://totp/Example%20Corp%3Abob?secret=MY&issuer=Example%20Corp&algorithm=SHA1&digits=6&period=30'
    );
  });
});

describe('fingerprintPublicKey', () => {
  test('is hex(sha256(pk))', () => {
    const pk = new Uint8Array(32).fill(0x03);
    expect(fingerprintPublicKey(pk)).toBe(fingerprintPublicKey(pk));
    expect(fingerprintPublicKey(pk)).toHaveLength(64);
    expect(fingerprintPublicKey(pk)).not.toBe(fingerprintPublicKey(new Uint8Array(32).fill(0x04)));
  });
});
