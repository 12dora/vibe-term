import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { argon2id } from 'hash-wasm';
import { type KdfParams, randomBytes } from './encoding';

export const ARGON2ID_MEMORY_KIB = 65536;
export const ARGON2ID_ITERATIONS = 3;
export const ARGON2ID_PARALLELISM = 1;
export const ARGON2ID_HASH_LENGTH = 32;
export const KDF_SALT_LENGTH = 16;
export const KDF_BUDGET_MEMORY_KIB_MAX = 262_144;
export const KDF_BUDGET_ITERATIONS_MAX = 10;
export const KDF_BUDGET_PARALLELISM_MAX = 4;

export class KdfParamsBudgetError extends Error {
  constructor(message = 'kdf params exceed client budget') {
    super(message);
    this.name = 'KdfParamsBudgetError';
  }
}

/** Argon2 调用前的客户端资源预算：超限直接拒绝，避免匿名 KDF 响应迫使 OOM。 */
export function assertKdfParamsWithinBudget(params: KdfParams): void {
  if (
    params.salt.byteLength !== KDF_SALT_LENGTH ||
    params.memory_kib < 8 ||
    params.memory_kib > KDF_BUDGET_MEMORY_KIB_MAX ||
    params.iterations < 1 ||
    params.iterations > KDF_BUDGET_ITERATIONS_MAX ||
    params.parallelism < 1 ||
    params.parallelism > KDF_BUDGET_PARALLELISM_MAX
  ) {
    throw new KdfParamsBudgetError();
  }
}

export interface RootKey {
  readonly publicKey: Uint8Array;
  readonly seed: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
}

export interface Ed25519KeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface X25519KeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateKdfParams(): KdfParams {
  return {
    salt: randomBytes(KDF_SALT_LENGTH),
    memory_kib: ARGON2ID_MEMORY_KIB,
    iterations: ARGON2ID_ITERATIONS,
    parallelism: ARGON2ID_PARALLELISM,
  };
}

export async function deriveSeed(password: string, kdfParams: KdfParams): Promise<Uint8Array> {
  assertKdfParamsWithinBudget(kdfParams);
  const normalized = password.normalize('NFKC');
  const digest = await argon2id({
    password: new TextEncoder().encode(normalized),
    salt: new Uint8Array(kdfParams.salt),
    parallelism: kdfParams.parallelism,
    iterations: kdfParams.iterations,
    memorySize: kdfParams.memory_kib,
    hashLength: ARGON2ID_HASH_LENGTH,
    outputType: 'binary',
  });
  return digest;
}

export function rootKeyFromSeed(seed: Uint8Array): RootKey {
  if (seed.length !== 32) {
    throw new Error('Ed25519 seed must be 32 bytes');
  }
  const owned = new Uint8Array(seed);
  const publicKey = ed25519.getPublicKey(owned);
  return {
    publicKey,
    seed: owned,
    sign(message: Uint8Array): Uint8Array {
      return ed25519.sign(message, owned);
    },
  };
}

export function signEd25519(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, secretKey);
}

export function verifyEd25519(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): boolean {
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  return ed25519.keygen();
}

export function generateX25519KeyPair(): X25519KeyPair {
  return x25519.keygen();
}
