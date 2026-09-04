import type { KeyLogRecord } from './encoding';
import {
  bytesEqual,
  decodeAdmitNodePayload,
  decodeAuthorization,
  decodeCertificate,
  nodeIdToHex,
  sha256,
} from './encoding';
import type { ApplyKeyLogCtx, ApplyKeyLogResult, UserKeyState } from './key-log';
import { verifyEd25519 } from './root-key';

type AdmitMaterial = {
  payload: ReturnType<typeof decodeAdmitNodePayload>;
  authorization: ReturnType<typeof decodeAuthorization>;
  certificate: ReturnType<typeof decodeCertificate>;
};

function decodeAdmitMaterial(record: KeyLogRecord): AdmitMaterial | ApplyKeyLogResult {
  let payload: AdmitMaterial['payload'];
  try {
    payload = decodeAdmitNodePayload(record.payload);
  } catch {
    return { ok: false, error: 'malformed_payload' };
  }
  try {
    return {
      payload,
      authorization: decodeAuthorization(payload.authorization_bytes),
      certificate: decodeCertificate(payload.certificate_bytes),
    };
  } catch {
    return { ok: false, error: 'malformed_payload' };
  }
}

async function verifyAuthorizationSig(
  state: UserKeyState,
  material: AdmitMaterial,
  ctx?: ApplyKeyLogCtx
): Promise<ApplyKeyLogResult | null> {
  const { payload, authorization } = material;
  if (authorization.signer === 'passkey') {
    const credentialId = authorization.credential_id;
    if (!credentialId) return { ok: false, error: 'bad_authorization_sig' };
    const cose = state.passkeys.get(credentialId)?.public_key ?? null;
    if (!cose || !ctx?.verifyPasskeyAssertion) return { ok: false, error: 'bad_authorization_sig' };
    const ok = await ctx.verifyPasskeyAssertion({
      recordBytes: payload.authorization_bytes,
      sig: payload.authorization_sig,
      credentialId,
      publicKey: cose,
      challenge: sha256(payload.authorization_bytes),
    });
    return ok ? null : { ok: false, error: 'bad_authorization_sig' };
  }
  if (authorization.signer === 'root') {
    if (
      payload.authorization_sig.length !== 64 ||
      !verifyEd25519(payload.authorization_sig, payload.authorization_bytes, state.rootPublicKey)
    ) {
      return { ok: false, error: 'bad_authorization_sig' };
    }
    return null;
  }
  return { ok: false, error: 'bad_authorization_sig' };
}

function verifyCertBindings(
  record: KeyLogRecord,
  material: AdmitMaterial
): ApplyKeyLogResult | null {
  const { payload, authorization, certificate } = material;
  if (!verifyEd25519(payload.cert_sig, payload.certificate_bytes, authorization.enroll_pk)) {
    return { ok: false, error: 'bad_cert_sig' };
  }
  if (!bytesEqual(certificate.enroll_pk, authorization.enroll_pk)) {
    return { ok: false, error: 'enroll_pk_mismatch' };
  }
  if (authorization.uid !== certificate.uid || authorization.uid !== record.uid) {
    return { ok: false, error: 'uid_mismatch' };
  }
  return null;
}

export async function verifyAdmitNodeMaterial(
  state: UserKeyState,
  record: KeyLogRecord,
  ctx?: ApplyKeyLogCtx
): Promise<{ ok: true; material: AdmitMaterial } | ApplyKeyLogResult> {
  const decoded = decodeAdmitMaterial(record);
  if (!('payload' in decoded)) return decoded;
  const authErr = await verifyAuthorizationSig(state, decoded, ctx);
  if (authErr) return authErr;
  const certErr = verifyCertBindings(record, decoded);
  if (certErr) return certErr;
  return { ok: true, material: decoded };
}

export async function applyReadmitNode(
  state: UserKeyState,
  record: KeyLogRecord,
  ctx?: ApplyKeyLogCtx
): Promise<ApplyKeyLogResult> {
  const verified = await verifyAdmitNodeMaterial(state, record, ctx);
  if (!('material' in verified)) return verified;
  const { payload, certificate } = verified.material;
  const hex = nodeIdToHex(certificate.node_id);
  const existing = state.nodeCerts.get(hex);
  if (!existing) return { ok: false, error: 'unknown_node' };
  if (existing.revoked) return { ok: false, error: 'node_revoked' };
  if (!bytesEqual(existing.certificateBytes, payload.certificate_bytes)) {
    return { ok: false, error: 'certificate_mismatch' };
  }
  state.nodeCerts.set(hex, {
    ...existing,
    authorizationBytes: new Uint8Array(payload.authorization_bytes),
    authorizationSig: new Uint8Array(payload.authorization_sig),
  });
  return { ok: true, state, effects: [] };
}
