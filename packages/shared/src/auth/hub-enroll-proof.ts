import { b } from '@zorsh/zorsh';
import { bytesEqual } from './encoding';
import { verifyEd25519 } from './root-key';

export const DOMAIN_HUB_ENROLL = 'tmex/hub-enroll/v1';
/** 调用方（Hub `/api/hub/enrollments/by-password`）按此窗口判定 `ts`。 */
export const HUB_ENROLL_PROOF_MAX_SKEW_MS = 5 * 60 * 1000;

export const HubEnrollProofSchema = b.struct({
  domain: b.string(),
  hub_host: b.string(),
  uid: b.string(),
  root_public_key: b.bytes(32),
  enroll_pk: b.bytes(32),
  ts: b.u64(),
});
export type HubEnrollProof = b.infer<typeof HubEnrollProofSchema>;

export type SignedHubEnrollProof = { bytes: Uint8Array; sig: Uint8Array };

export type HubEnrollProofSigner = {
  readonly publicKey: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
};

export type VerifyHubEnrollProofError =
  | 'malformed'
  | 'domain_mismatch'
  | 'hub_host_mismatch'
  | 'uid_mismatch'
  | 'root_public_key_mismatch'
  | 'enroll_pk_mismatch'
  | 'ts_skew'
  | 'bad_signature';

export type VerifyHubEnrollProofResult =
  | { ok: true; proof: HubEnrollProof }
  | { ok: false; error: VerifyHubEnrollProofError };

export function encodeHubEnrollProof(input: {
  hubHost: string;
  uid: string;
  rootPublicKey: Uint8Array;
  enrollPk: Uint8Array;
  ts: number | bigint;
}): Uint8Array {
  if (input.rootPublicKey.byteLength !== 32) {
    throw new Error('root public key must be 32 bytes');
  }
  if (input.enrollPk.byteLength !== 32) {
    throw new Error('enroll public key must be 32 bytes');
  }
  if (!input.hubHost) {
    throw new Error('hub host must not be empty');
  }
  if (!input.uid) {
    throw new Error('uid must not be empty');
  }
  return HubEnrollProofSchema.serialize({
    domain: DOMAIN_HUB_ENROLL,
    hub_host: input.hubHost,
    uid: input.uid,
    root_public_key: new Uint8Array(input.rootPublicKey),
    enroll_pk: new Uint8Array(input.enrollPk),
    ts: typeof input.ts === 'bigint' ? input.ts : BigInt(Math.trunc(input.ts)),
  });
}

export function decodeHubEnrollProof(bytes: Uint8Array): HubEnrollProof {
  const value = HubEnrollProofSchema.deserialize(bytes);
  if (value.domain !== DOMAIN_HUB_ENROLL) {
    throw new Error(`domain mismatch: expected ${DOMAIN_HUB_ENROLL}, got ${value.domain}`);
  }
  return value;
}

/** 根钥对 `{domain, hub_host, uid, root_public_key, enroll_pk, ts}` 签名，证明持有 mesh 账户密码。 */
export function signHubEnrollProof(
  rootKey: HubEnrollProofSigner,
  input: { hubHost: string; uid: string; enrollPk: Uint8Array; ts: number | bigint }
): SignedHubEnrollProof {
  const bytes = encodeHubEnrollProof({
    hubHost: input.hubHost,
    uid: input.uid,
    rootPublicKey: rootKey.publicKey,
    enrollPk: input.enrollPk,
    ts: input.ts,
  });
  return { bytes, sig: rootKey.sign(bytes) };
}

export function verifyHubEnrollProof(input: {
  bytes: Uint8Array;
  sig: Uint8Array;
  hubHost: string;
  uid?: string;
  rootPublicKey: Uint8Array;
  enrollPk: Uint8Array;
  /** 传入即按 ±HUB_ENROLL_PROOF_MAX_SKEW_MS 判定时间窗。 */
  now?: number | bigint;
  maxSkewMs?: number;
}): VerifyHubEnrollProofResult {
  let proof: HubEnrollProof;
  try {
    proof = decodeHubEnrollProof(input.bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return {
      ok: false,
      error: message.startsWith('domain mismatch') ? 'domain_mismatch' : 'malformed',
    };
  }
  const mismatch = matchHubEnrollProof(proof, input);
  if (mismatch) return { ok: false, error: mismatch };
  if (input.sig.byteLength !== 64 || !verifyEd25519(input.sig, input.bytes, input.rootPublicKey)) {
    return { ok: false, error: 'bad_signature' };
  }
  return { ok: true, proof };
}

function matchHubEnrollProof(
  proof: HubEnrollProof,
  input: {
    hubHost: string;
    uid?: string;
    rootPublicKey: Uint8Array;
    enrollPk: Uint8Array;
    now?: number | bigint;
    maxSkewMs?: number;
  }
): VerifyHubEnrollProofError | null {
  if (proof.hub_host !== input.hubHost) return 'hub_host_mismatch';
  if (input.uid !== undefined && proof.uid !== input.uid) return 'uid_mismatch';
  if (!bytesEqual(proof.root_public_key, input.rootPublicKey)) return 'root_public_key_mismatch';
  if (!bytesEqual(proof.enroll_pk, input.enrollPk)) return 'enroll_pk_mismatch';
  if (input.now === undefined) return null;
  const now = typeof input.now === 'bigint' ? input.now : BigInt(Math.trunc(input.now));
  const skew = BigInt(input.maxSkewMs ?? HUB_ENROLL_PROOF_MAX_SKEW_MS);
  const delta = proof.ts > now ? proof.ts - now : now - proof.ts;
  return delta > skew ? 'ts_skew' : null;
}
