import { describe, expect, it } from 'bun:test';
import { x25519 } from '@noble/curves/ed25519.js';
import {
  DOMAIN_DELEGATION,
  bytesEqual,
  bytesToHex,
  encodeDelegation,
  hexToBytes,
} from './encoding';
import {
  ARGON2ID_ITERATIONS,
  ARGON2ID_MEMORY_KIB,
  ARGON2ID_PARALLELISM,
  deriveSeed,
  generateEd25519KeyPair,
  generateKdfParams,
  generateX25519KeyPair,
  rootKeyFromSeed,
  signEd25519,
  verifyEd25519,
} from './root-key';

const ARGON2_VECTOR_SEED = 'c309e52473a3209eb21f065c873725f397a79dc8de84d30b078f95c2a3ae8c85';
const CANONICAL_ROOT_PK = '4ecb7f7d549e39da61154177e3a6bb1002106c106df014bbc6e9fc34e8943860';
const CANONICAL_DELEGATION_SIG =
  '6b86235d9bf23a13f7c906fe3e65c90af14bf33324899ed70184884224585410264a7d3a6f884a060e6b64c303e2844ad2cef5b322746145ecc698962b2c210b';

describe('deriveSeed', () => {
  it(
    'matches the locked Argon2id vector (hash-wasm == independent impl)',
    async () => {
      const seed = await deriveSeed('tmex-test', {
        salt: new Uint8Array(16).fill(1),
        memory_kib: ARGON2ID_MEMORY_KIB,
        iterations: ARGON2ID_ITERATIONS,
        parallelism: ARGON2ID_PARALLELISM,
      });
      expect(bytesToHex(seed)).toBe(ARGON2_VECTOR_SEED);
    },
    { timeout: 15_000 }
  );

  it(
    'NFKC-normalizes the password before KDF',
    async () => {
      const params = {
        salt: new Uint8Array(16).fill(1),
        memory_kib: ARGON2ID_MEMORY_KIB,
        iterations: ARGON2ID_ITERATIONS,
        parallelism: ARGON2ID_PARALLELISM,
      };
      const composed = await deriveSeed('\u00e9', params);
      const decomposed = await deriveSeed('e\u0301', params);
      expect(bytesEqual(composed, decomposed)).toBe(true);
    },
    { timeout: 15_000 }
  );
});

describe('canonical password → seed → root pk → delegation signature', () => {
  it(
    'locks the protocol test vector',
    async () => {
      const seed = await deriveSeed('tmex-test', {
        salt: new Uint8Array(16).fill(1),
        memory_kib: ARGON2ID_MEMORY_KIB,
        iterations: ARGON2ID_ITERATIONS,
        parallelism: ARGON2ID_PARALLELISM,
      });
      expect(bytesToHex(seed)).toBe(ARGON2_VECTOR_SEED);

      const root = rootKeyFromSeed(seed);
      expect(bytesToHex(root.publicKey)).toBe(CANONICAL_ROOT_PK);

      const delegationBytes = encodeDelegation({
        domain: DOMAIN_DELEGATION,
        uid: 'user-1',
        sess_pk: new Uint8Array(32).fill(2),
        issued_at: 1_000_000_000_000n,
        exp: 1_000_064_800_000n,
        method: 'root',
        credential_id: null,
      });
      const sig = root.sign(delegationBytes);
      expect(bytesToHex(sig)).toBe(CANONICAL_DELEGATION_SIG);
      expect(verifyEd25519(sig, delegationBytes, root.publicKey)).toBe(true);
    },
    { timeout: 15_000 }
  );
});

describe('Ed25519 / X25519 wrappers', () => {
  it('generateKdfParams uses a 16-byte random salt and fixed costs', () => {
    const a = generateKdfParams();
    const b = generateKdfParams();
    expect(a.salt.length).toBe(16);
    expect(a.memory_kib).toBe(65536);
    expect(a.iterations).toBe(3);
    expect(a.parallelism).toBe(1);
    expect(bytesEqual(a.salt, b.salt)).toBe(false);
  });

  it('sign/verify is RFC 8032 strict (zip215: false)', () => {
    const kp = generateEd25519KeyPair();
    const msg = new TextEncoder().encode('tmex');
    const sig = signEd25519(kp.secretKey, msg);
    expect(verifyEd25519(sig, msg, kp.publicKey)).toBe(true);
    expect(verifyEd25519(sig, new TextEncoder().encode('other'), kp.publicKey)).toBe(false);
    expect(verifyEd25519(sig, msg, hexToBytes(CANONICAL_ROOT_PK))).toBe(false);
  });

  it('X25519 keygen agrees on a shared secret', () => {
    const a = generateX25519KeyPair();
    const b = generateX25519KeyPair();
    const ab = x25519.getSharedSecret(a.secretKey, b.publicKey);
    const ba = x25519.getSharedSecret(b.secretKey, a.publicKey);
    expect(bytesEqual(ab, ba)).toBe(true);
    expect(ab.length).toBe(32);
  });
});
