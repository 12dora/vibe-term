import { describe, expect, test } from 'bun:test';
import { base32Decode, base32Encode, buildOtpauthUri, generateTotpSecret } from './totp-uri';

describe('base32', () => {
  test('RFC 4648 测试向量（无 padding）', () => {
    const encoder = new TextEncoder();
    expect(base32Encode(encoder.encode('f'))).toBe('MY');
    expect(base32Encode(encoder.encode('fo'))).toBe('MZXQ');
    expect(base32Encode(encoder.encode('foo'))).toBe('MZXW6');
    expect(base32Encode(encoder.encode('foobar'))).toBe('MZXW6YTBOI');
  });

  test('往返', () => {
    const secret = generateTotpSecret();
    expect(secret).toHaveLength(20);
    expect(base32Decode(base32Encode(secret))).toEqual(secret);
  });
});

describe('buildOtpauthUri', () => {
  test('按 Key Uri Format 拼装', () => {
    const uri = buildOtpauthUri({
      secret: new TextEncoder().encode('foobar'),
      account: 'alice',
      issuer: 'tmex',
    });
    expect(uri.startsWith('otpauth://totp/tmex:alice?')).toBe(true);
    const params = new URLSearchParams(uri.split('?')[1]);
    expect(params.get('secret')).toBe('MZXW6YTBOI');
    expect(params.get('issuer')).toBe('tmex');
    expect(params.get('algorithm')).toBe('SHA1');
    expect(params.get('digits')).toBe('6');
    expect(params.get('period')).toBe('30');
  });
});
