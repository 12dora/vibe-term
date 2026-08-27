import { describe, expect, it } from 'bun:test';
import {
  DELEGATION_TTL_MS,
  buildPasskeyDelegation,
  createDelegation,
  delegationChallenge,
  verifyDelegation,
} from './delegation';
import { bytesEqual, bytesToHex } from './encoding';
import { generateEd25519KeyPair, rootKeyFromSeed } from './root-key';

function rootFrom(byte: number) {
  return rootKeyFromSeed(new Uint8Array(32).fill(byte));
}

describe('createDelegation / verifyDelegation', () => {
  const now = 1_700_000_000_000;
  const sess = generateEd25519KeyPair();
  const root = rootFrom(9);

  it('issues a 18h root delegation that verifies', () => {
    const { delegation, sig } = createDelegation(root, {
      uid: 'user-1',
      sessPk: sess.publicKey,
      now,
    });
    expect(delegation.method).toBe('root');
    expect(delegation.exp - delegation.issued_at).toBe(BigInt(DELEGATION_TTL_MS));
    const ok = verifyDelegation(delegation, sig, { rootPublicKey: root.publicKey, now });
    expect(ok).toEqual({ ok: true, delegation });
  });

  it('rejects expired delegations', () => {
    const { delegation, sig } = createDelegation(root, {
      uid: 'user-1',
      sessPk: sess.publicKey,
      now,
    });
    const expired = verifyDelegation(delegation, sig, {
      rootPublicKey: root.publicKey,
      now: now + DELEGATION_TTL_MS,
    });
    expect(expired).toEqual({ ok: false, error: 'expired' });
  });

  it('rejects a signature from a different root', () => {
    const { delegation, sig } = createDelegation(root, {
      uid: 'user-1',
      sessPk: sess.publicKey,
      now,
    });
    const other = rootFrom(3);
    expect(verifyDelegation(delegation, sig, { rootPublicKey: other.publicKey, now })).toEqual({
      ok: false,
      error: 'bad_signature',
    });
  });

  it('refuses passkey method on the root verifier', () => {
    const delegation = buildPasskeyDelegation({
      uid: 'user-1',
      sessPk: sess.publicKey,
      now,
      credentialId: 'cred',
    });
    expect(delegation.method).toBe('passkey');
    expect(
      verifyDelegation(delegation, new Uint8Array(64), { rootPublicKey: root.publicKey, now })
    ).toEqual({
      ok: false,
      error: 'method_mismatch',
    });
  });

  it('delegationChallenge is sha256 of the borsh encoding', () => {
    const delegation = buildPasskeyDelegation({
      uid: 'user-1',
      sessPk: sess.publicKey,
      now,
      credentialId: 'cred',
    });
    const challenge = delegationChallenge(delegation);
    expect(challenge.length).toBe(32);
    expect(bytesToHex(challenge)).not.toBe(bytesToHex(new Uint8Array(32)));
    expect(bytesEqual(challenge, delegationChallenge(delegation))).toBe(true);
  });
});
