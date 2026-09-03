import { describe, expect, it } from 'bun:test';
import { decodeB64url } from './b64url';
import { encodeBase64url, randomBytes } from './encoding';

describe('decodeB64url', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(decodeB64url(encodeBase64url(bytes))).toEqual(bytes);
  });

  it('rejects empty and invalid input', () => {
    expect(() => decodeB64url('')).toThrow('invalid b64url');
    expect(() => decodeB64url('!!!')).toThrow('invalid b64url');
  });

  it('enforces expected length', () => {
    const bytes = randomBytes(32);
    const encoded = encodeBase64url(bytes);
    expect(decodeB64url(encoded, 32)).toEqual(bytes);
    expect(() => decodeB64url(encoded, 16)).toThrow('expected 16 bytes');
  });
});
