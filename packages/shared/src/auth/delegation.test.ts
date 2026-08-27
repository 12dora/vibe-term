import { describe, expect, it } from 'bun:test';
import {
  DELEGATION_CLOCK_SKEW_MS,
  DELEGATION_TTL_MS,
  buildPasskeyDelegation,
  createDelegation,
  delegationChallenge,
  verifyDelegation,
  verifyDelegationTimes,
} from './delegation';
import { bytesEqual, bytesToHex, encodeDelegation } from './encoding';
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

  it('locks the canonical root delegation challenge', () => {
    const delegation = {
      domain: 'tmex/delegation/v1',
      uid: 'user-1',
      sess_pk: new Uint8Array(32).fill(2),
      issued_at: 1_000_000_000_000n,
      exp: 1_000_064_800_000n,
      method: 'root' as const,
      credential_id: null,
    };
    expect(bytesToHex(encodeDelegation(delegation))).toBe(
      '12000000746d65782f64656c65676174696f6e2f763106000000757365722d3102020202020202020202020202020202020202020202020202020202020202020010a5d4e800000000d581d8e80000000000'
    );
    expect(bytesToHex(delegationChallenge(delegation))).toBe(
      'e4433e2bbac0a67454e17b19ac13a0df8015c44847853d92c15c4b50d910ba0f'
    );
  });
});

describe('verifyDelegationTimes', () => {
  const now = 1_700_000_000_000;
  const sess = generateEd25519KeyPair();

  it('requires exp - issued_at === DELEGATION_TTL_MS', () => {
    const delegation = buildPasskeyDelegation({
      uid: 'user-1',
      sessPk: sess.publicKey,
      now,
      credentialId: 'cred',
    });
    expect(verifyDelegationTimes(delegation, now)).toEqual({ ok: true });
    expect(verifyDelegationTimes({ ...delegation, exp: delegation.issued_at + 1n }, now)).toEqual({
      ok: false,
      error: 'invalid_ttl',
    });
    expect(
      verifyDelegationTimes({ ...delegation, issued_at: 0n, exp: 9_223_372_036_854_775_807n }, now)
    ).toEqual({ ok: false, error: 'invalid_ttl' });
  });

  it('rejects issued_at more than 60s in the future and shares the check with root verify', () => {
    const root = rootFrom(9);
    const future = now + DELEGATION_CLOCK_SKEW_MS + 1;
    const { delegation, sig } = createDelegation(root, {
      uid: 'user-1',
      sessPk: sess.publicKey,
      now: future,
    });
    expect(verifyDelegationTimes(delegation, now)).toEqual({
      ok: false,
      error: 'issued_in_future',
    });
    expect(verifyDelegation(delegation, sig, { rootPublicKey: root.publicKey, now })).toEqual({
      ok: false,
      error: 'issued_in_future',
    });

    const skewOk = createDelegation(root, {
      uid: 'user-1',
      sessPk: sess.publicKey,
      now: now + DELEGATION_CLOCK_SKEW_MS,
    });
    expect(verifyDelegationTimes(skewOk.delegation, now)).toEqual({ ok: true });
    expect(
      verifyDelegation(skewOk.delegation, skewOk.sig, { rootPublicKey: root.publicKey, now })
    ).toEqual({ ok: true, delegation: skewOk.delegation });
  });

  it('rejects now >= exp after TTL and issued_at checks', () => {
    const root = rootFrom(9);
    const { delegation, sig } = createDelegation(root, {
      uid: 'user-1',
      sessPk: sess.publicKey,
      now,
    });
    expect(verifyDelegationTimes(delegation, now + DELEGATION_TTL_MS)).toEqual({
      ok: false,
      error: 'expired',
    });
    expect(
      verifyDelegation(delegation, sig, {
        rootPublicKey: root.publicKey,
        now: now + DELEGATION_TTL_MS,
      })
    ).toEqual({ ok: false, error: 'expired' });
  });
});
