import { describe, expect, it } from 'bun:test';
import { bytesToHex } from './encoding';
import { deriveTotpKey, totpCode, verifyTotpCode } from './totp';

const RFC6238_SHA1_SECRET = new TextEncoder().encode('12345678901234567890');

describe('totpCode RFC 6238 SHA-1 vectors (8 digits)', () => {
  const cases: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  for (const [time, expected] of cases) {
    it(`T=${time} → ${expected}`, () => {
      expect(totpCode(RFC6238_SHA1_SECRET, time, { digits: 8 })).toBe(expected);
    });
  }
});

describe('verifyTotpCode', () => {
  it('accepts the current step and ±1 neighbour', () => {
    const secret = RFC6238_SHA1_SECRET;
    const time = 1111111111;
    const code = totpCode(secret, time, { digits: 8 });
    expect(verifyTotpCode(secret, code, time, { digits: 8 })).toBe(true);
    expect(verifyTotpCode(secret, code, time + 30, { digits: 8 })).toBe(true);
    expect(verifyTotpCode(secret, code, time - 30, { digits: 8 })).toBe(true);
    expect(verifyTotpCode(secret, code, time + 90, { digits: 8 })).toBe(false);
    expect(verifyTotpCode(secret, '00000000', time, { digits: 8 })).toBe(false);
  });

  it('defaults to 6 digits', () => {
    expect(totpCode(RFC6238_SHA1_SECRET, 59).length).toBe(6);
  });
});

describe('deriveTotpKey HKDF vector', () => {
  it('locks HKDF-SHA-256(seed, salt="tmex-totp"||u32LE(epoch), info=uid, 32)', () => {
    const seed = new Uint8Array(32).fill(0x11);
    expect(bytesToHex(deriveTotpKey(seed, 'user-1', 0))).toBe(
      'f5104f9232dae1a6b6d3a5b60b6263e8a55edf41484e66c7992a451555318e06'
    );
    expect(bytesToHex(deriveTotpKey(seed, 'user-1', 1))).toBe(
      '437adb4c3dc6cdaa0c8cc7cd4593aa0db668f1afb41abb9f1366cdd38b756513'
    );
  });
});
