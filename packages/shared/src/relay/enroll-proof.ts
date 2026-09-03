import { b } from '@zorsh/zorsh';
import { bytesEqual } from '../auth/encoding';
import { verifyEd25519 } from '../auth/root-key';

export const DOMAIN_RELAY_ENROLL = 'tmex/relay-enroll/v1';
/** 调用方（中继侧 `/api/relay/enroll`）按此窗口判定 `ts`。 */
export const RELAY_ENROLL_PROOF_MAX_SKEW_MS = 5 * 60 * 1000;

export const RelayEnrollProofSchema = b.struct({
  domain: b.string(),
  relay_host: b.string(),
  root_public_key: b.bytes(32),
  ts: b.u64(),
});
export type RelayEnrollProof = b.infer<typeof RelayEnrollProofSchema>;

export type SignedRelayEnrollProof = { bytes: Uint8Array; sig: Uint8Array };

export type RelayEnrollProofSigner = {
  readonly publicKey: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
};

export type VerifyRelayEnrollProofError =
  | 'malformed'
  | 'domain_mismatch'
  | 'relay_host_mismatch'
  | 'root_public_key_mismatch'
  | 'ts_skew'
  | 'bad_signature';

export type VerifyRelayEnrollProofResult =
  | { ok: true; proof: RelayEnrollProof }
  | { ok: false; error: VerifyRelayEnrollProofError };

export function encodeRelayEnrollProof(input: {
  relayHost: string;
  rootPublicKey: Uint8Array;
  ts: number | bigint;
}): Uint8Array {
  if (input.rootPublicKey.byteLength !== 32) {
    throw new Error('root public key must be 32 bytes');
  }
  if (!input.relayHost) {
    throw new Error('relay host must not be empty');
  }
  return RelayEnrollProofSchema.serialize({
    domain: DOMAIN_RELAY_ENROLL,
    relay_host: input.relayHost,
    root_public_key: new Uint8Array(input.rootPublicKey),
    ts: typeof input.ts === 'bigint' ? input.ts : BigInt(Math.trunc(input.ts)),
  });
}

export function decodeRelayEnrollProof(bytes: Uint8Array): RelayEnrollProof {
  const value = RelayEnrollProofSchema.deserialize(bytes);
  if (value.domain !== DOMAIN_RELAY_ENROLL) {
    throw new Error(`domain mismatch: expected ${DOMAIN_RELAY_ENROLL}, got ${value.domain}`);
  }
  return value;
}

/** 根钥对 `{domain, relay_host, root_public_key, ts}` 签名，防止拿别人的根公钥去中继占坑。 */
export function signRelayEnrollProof(
  rootKey: RelayEnrollProofSigner,
  input: { relayHost: string; ts: number | bigint }
): SignedRelayEnrollProof {
  const bytes = encodeRelayEnrollProof({
    relayHost: input.relayHost,
    rootPublicKey: rootKey.publicKey,
    ts: input.ts,
  });
  return { bytes, sig: rootKey.sign(bytes) };
}

export function verifyRelayEnrollProof(input: {
  bytes: Uint8Array;
  sig: Uint8Array;
  relayHost: string;
  rootPublicKey: Uint8Array;
  /** 传入即按 ±RELAY_ENROLL_PROOF_MAX_SKEW_MS 判定时间窗。 */
  now?: number | bigint;
  maxSkewMs?: number;
}): VerifyRelayEnrollProofResult {
  let proof: RelayEnrollProof;
  try {
    proof = decodeRelayEnrollProof(input.bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return {
      ok: false,
      error: message.startsWith('domain mismatch') ? 'domain_mismatch' : 'malformed',
    };
  }
  if (proof.relay_host !== input.relayHost) {
    return { ok: false, error: 'relay_host_mismatch' };
  }
  if (!bytesEqual(proof.root_public_key, input.rootPublicKey)) {
    return { ok: false, error: 'root_public_key_mismatch' };
  }
  if (input.now !== undefined) {
    const now = typeof input.now === 'bigint' ? input.now : BigInt(Math.trunc(input.now));
    const skew = BigInt(input.maxSkewMs ?? RELAY_ENROLL_PROOF_MAX_SKEW_MS);
    const delta = proof.ts > now ? proof.ts - now : now - proof.ts;
    if (delta > skew) return { ok: false, error: 'ts_skew' };
  }
  if (input.sig.byteLength !== 64 || !verifyEd25519(input.sig, input.bytes, input.rootPublicKey)) {
    return { ok: false, error: 'bad_signature' };
  }
  return { ok: true, proof };
}
