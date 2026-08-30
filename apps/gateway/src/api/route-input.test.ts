import { describe, expect, test } from 'bun:test';
import { encodeBase64url } from '@tmex/shared/auth';
import {
  decodeB64url,
  requireB64url,
  requireBodyString,
  requiredStrings,
  validationError,
} from './route-input';

describe('route-input', () => {
  test('requiredStrings keeps empty strings and rejects missing/non-string fields', () => {
    expect(requiredStrings({ a: 'x', b: '' }, ['a', 'b'])).toEqual({ a: 'x', b: '' });
    expect(requiredStrings({ a: 'x' }, ['a', 'b'])).toBeNull();
    expect(requiredStrings({ a: 1, b: 'y' }, ['a', 'b'])).toBeNull();
  });

  test('requireBodyString / b64url / validationError match hub messages', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const encoded = encodeBase64url(bytes);
    expect(requireBodyString({ k: 'v' }, 'k')).toBe('v');
    expect(() => requireBodyString({ k: '' }, 'k')).toThrow('missing k');
    expect(decodeB64url(encoded)).toEqual(bytes);
    expect(requireB64url({ f: encoded }, 'f', 4)).toEqual(bytes);
    expect(() => decodeB64url('')).toThrow('invalid b64url');
    expect(() => decodeB64url(encoded, 3)).toThrow('expected 3 bytes');
    expect(await validationError(new Error('missing certificate')).json()).toEqual({
      error: 'missing certificate',
    });
    expect(await validationError('nope').json()).toEqual({ error: 'invalid_fields' });
  });
});
