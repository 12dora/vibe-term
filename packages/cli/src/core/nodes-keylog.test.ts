import { describe, expect, test } from 'bun:test';
import { encodeBase64url } from '@vibeterm/shared/auth';
import { AuthError, UsageError } from './errors';
import { assertKdfParamsFloor, assertNodeHexId, assertRootMatchesMode } from './nodes-keylog';

describe('nodes-keylog guards', () => {
  test('assertKdfParamsFloor refuses weaker argon2id params', () => {
    expect(() => assertKdfParamsFloor({ memory_kib: 64, iterations: 3, parallelism: 1 })).toThrow(
      AuthError
    );
    expect(() =>
      assertKdfParamsFloor({ memory_kib: 65536, iterations: 2, parallelism: 1 })
    ).toThrow(AuthError);
    expect(() =>
      assertKdfParamsFloor({ memory_kib: 65536, iterations: 3, parallelism: 1 })
    ).not.toThrow();
  });

  test('assertRootMatchesMode rejects a typo and a missing advertised key', () => {
    const publicKey = new Uint8Array(32).fill(7);
    const seed = new Uint8Array(32);
    const root = { publicKey, seed, sign: () => new Uint8Array() };
    expect(() => assertRootMatchesMode(root, { rootPublicKey: null } as never)).toThrow(AuthError);
    expect(() =>
      assertRootMatchesMode(root, {
        rootPublicKey: encodeBase64url(new Uint8Array(32).fill(1)),
      } as never)
    ).toThrow(AuthError);
    expect(seed.every((byte) => byte === 0)).toBe(true);
    const seed2 = new Uint8Array(32).fill(9);
    const root2 = { publicKey, seed: seed2, sign: () => new Uint8Array() };
    expect(() =>
      assertRootMatchesMode(root2, { rootPublicKey: encodeBase64url(publicKey) } as never)
    ).not.toThrow();
  });

  test('assertNodeHexId runs before any derive', () => {
    expect(() => assertNodeHexId('not-a-node')).toThrow(UsageError);
    expect(() => assertNodeHexId('A'.repeat(32))).toThrow(UsageError);
    expect(() => assertNodeHexId('a'.repeat(32))).not.toThrow();
  });
});
