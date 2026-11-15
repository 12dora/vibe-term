import { describe, expect, it } from 'bun:test';
import { generateEd25519KeyPair, signEd25519 } from './root-key';
import {
  canonicalPopPath,
  canonicalPopQuery,
  parsePopProof,
  popTargetFromUrl,
  signPop,
  verifyPop,
} from './session-pop';

describe('session pop', () => {
  const pair = generateEd25519KeyPair();
  const signer = (message: Uint8Array) => signEd25519(pair.secretKey, message);

  it('strips node prefixes and the pop param', () => {
    expect(canonicalPopPath(`/n/${'a'.repeat(32)}/api/x`)).toBe('/api/x');
    expect(canonicalPopPath('/n/self/ws')).toBe('/ws');
    expect(canonicalPopPath('/n/self')).toBe('/');
    expect(canonicalPopPath('/api/n/self')).toBe('/api/n/self');
    expect(canonicalPopQuery('?cid=1&pop=v1.x&b=2')).toBe('cid=1&b=2');
    expect(canonicalPopQuery('')).toBe('');
  });

  it('signs and verifies a request through an entry prefix', async () => {
    const now = 1_700_000_000_000;
    const proof = await signPop(
      signer,
      popTargetFromUrl('post', `/n/${'b'.repeat(32)}/api/x?y=1`),
      now
    );
    const target = popTargetFromUrl('POST', 'http://node.example.com/api/x?y=1');
    expect(verifyPop(pair.publicKey, proof, target, now + 1000).ok).toBe(true);
  });

  it('rejects tampering, skew and malformed values', async () => {
    const now = 1_700_000_000_000;
    const target = popTargetFromUrl('GET', '/api/x');
    const proof = await signPop(signer, target, now);
    expect(verifyPop(pair.publicKey, proof, { ...target, path: '/api/y' }, now)).toEqual({
      ok: false,
      error: 'bad_signature',
    });
    expect(verifyPop(pair.publicKey, proof, target, now + 61_000)).toEqual({
      ok: false,
      error: 'expired',
    });
    expect(verifyPop(pair.publicKey, 'v2.1.x.y', target, now)).toEqual({
      ok: false,
      error: 'malformed',
    });
    expect(parsePopProof(null)).toBeNull();
  });
});
