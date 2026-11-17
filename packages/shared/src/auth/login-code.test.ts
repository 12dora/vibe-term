import { describe, expect, it } from 'bun:test';
import {
  LOGIN_CODE_PREFIX,
  decodeLoginCode,
  deriveNodeLoginCode,
  encodeLoginCode,
  generateLoginCodeSecret,
  loginCodeHashHex,
} from './login-code';

const A = '0123456789abcdef0123456789abcdef';
const B = 'fedcba9876543210fedcba9876543210';

describe('login code', () => {
  it('round-trips secret and node ids in order', () => {
    const secret = generateLoginCodeSecret();
    const code = encodeLoginCode({ secret, nodeIds: [B, A] });
    expect(code.startsWith(LOGIN_CODE_PREFIX)).toBe(true);
    const parts = decodeLoginCode(`  ${code}\n`);
    expect(parts?.nodeIds).toEqual([B, A]);
    expect(parts?.secret).toEqual(secret);
  });

  it('rejects malformed codes', () => {
    const code = encodeLoginCode({ secret: generateLoginCodeSecret(), nodeIds: [A] });
    expect(decodeLoginCode(code.slice(0, -2))).toBeNull();
    expect(decodeLoginCode(code.replace(LOGIN_CODE_PREFIX, 'vtl2_'))).toBeNull();
    expect(decodeLoginCode(`${code}=`)).toBeNull();
    expect(decodeLoginCode(LOGIN_CODE_PREFIX)).toBeNull();
    expect(() => encodeLoginCode({ secret: new Uint8Array(8), nodeIds: [A] })).toThrow();
    expect(() => encodeLoginCode({ secret: generateLoginCodeSecret(), nodeIds: [] })).toThrow();
    expect(() =>
      encodeLoginCode({ secret: generateLoginCodeSecret(), nodeIds: ['self'] })
    ).toThrow();
  });

  it('dedupes on encode and refuses duplicates on decode', () => {
    const secret = generateLoginCodeSecret();
    expect(decodeLoginCode(encodeLoginCode({ secret, nodeIds: [A, A] }))?.nodeIds).toEqual([A]);
  });

  it('derives distinct per-node codes', () => {
    const secret = generateLoginCodeSecret();
    const a = deriveNodeLoginCode(secret, A);
    const b = deriveNodeLoginCode(secret, B);
    expect(a.length).toBe(32);
    expect(loginCodeHashHex(a)).not.toBe(loginCodeHashHex(b));
    expect(deriveNodeLoginCode(secret, A)).toEqual(a);
  });
});
