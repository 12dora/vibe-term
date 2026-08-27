import type { Delegation } from './encoding';
import { DOMAIN_DELEGATION, encodeDelegation, sha256 } from './encoding';
import type { RootKey } from './root-key';
import { verifyEd25519 } from './root-key';

export const DELEGATION_TTL_MS = 18 * 60 * 60 * 1000;

export type SignedDelegation = {
  delegation: Delegation;
  bytes: Uint8Array;
  sig: Uint8Array;
};

export type VerifyDelegationResult =
  | { ok: true; delegation: Delegation }
  | { ok: false; error: 'expired' | 'bad_signature' | 'method_mismatch' };

export type VerifyDelegationPasskey = (args: {
  challenge: Uint8Array;
  delegation: Delegation;
  assertion: unknown;
  credentialId: string;
}) => boolean | Promise<boolean>;

function toMs(now: number | bigint): bigint {
  return typeof now === 'bigint' ? now : BigInt(now);
}

export function createDelegation(
  rootKey: RootKey,
  opts: { uid: string; sessPk: Uint8Array; now: number | bigint; credentialId?: string | null }
): SignedDelegation {
  if (opts.sessPk.length !== 32) {
    throw new Error('sessPk must be 32 bytes');
  }
  const issuedAt = toMs(opts.now);
  const delegation: Delegation = {
    domain: DOMAIN_DELEGATION,
    uid: opts.uid,
    sess_pk: new Uint8Array(opts.sessPk),
    issued_at: issuedAt,
    exp: issuedAt + BigInt(DELEGATION_TTL_MS),
    method: 'root',
    credential_id: opts.credentialId ?? null,
  };
  const bytes = encodeDelegation(delegation);
  return { delegation, bytes, sig: rootKey.sign(bytes) };
}

export function verifyDelegation(
  delegation: Delegation,
  sig: Uint8Array,
  ctx: { rootPublicKey: Uint8Array; now: number | bigint }
): VerifyDelegationResult {
  if (delegation.method !== 'root') {
    return { ok: false, error: 'method_mismatch' };
  }
  if (toMs(ctx.now) >= delegation.exp) {
    return { ok: false, error: 'expired' };
  }
  const bytes = encodeDelegation(delegation);
  if (!verifyEd25519(sig, bytes, ctx.rootPublicKey)) {
    return { ok: false, error: 'bad_signature' };
  }
  return { ok: true, delegation };
}

export function delegationChallenge(delegation: Delegation): Uint8Array {
  return sha256(encodeDelegation(delegation));
}

export function buildPasskeyDelegation(opts: {
  uid: string;
  sessPk: Uint8Array;
  now: number | bigint;
  credentialId: string;
}): Delegation {
  if (opts.sessPk.length !== 32) {
    throw new Error('sessPk must be 32 bytes');
  }
  const issuedAt = toMs(opts.now);
  return {
    domain: DOMAIN_DELEGATION,
    uid: opts.uid,
    sess_pk: new Uint8Array(opts.sessPk),
    issued_at: issuedAt,
    exp: issuedAt + BigInt(DELEGATION_TTL_MS),
    method: 'passkey',
    credential_id: opts.credentialId,
  };
}
