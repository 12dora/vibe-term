import {
  decodeAdmitNodePayload,
  decodeCertificate,
  decodeKeyLogRecord,
  decodeRevokeNodePayload,
  nodeIdToHex,
  verifyEd25519,
} from '@tmex/shared/auth';
import { decodeB64url } from '../api/route-input';

export type RelayMemberSigner = 'root' | 'passkey';

export type RelayMemberAdmit = {
  ok: true;
  op: 'admit';
  signer: RelayMemberSigner;
  nodeId: string;
  edPk: Uint8Array;
  x25519Pk: Uint8Array;
  seq: bigint;
};

export type RelayMemberRevoke = {
  ok: true;
  op: 'revoke';
  signer: 'root';
  nodeId: string;
  seq: bigint;
};

export type RelayMemberError =
  | 'malformed'
  | 'type_mismatch'
  | 'bad_signature'
  | 'node_mismatch'
  /** passkey 签名的记录中继无法验签（验签需要 clientDataJSON），revoke 一律忽略。 */
  | 'passkey_unverifiable';

export type RelayMemberResult =
  | RelayMemberAdmit
  | RelayMemberRevoke
  | { ok: false; error: RelayMemberError };

export type RelayMemberProofInput = {
  bytes: string;
  sig: string;
};

function decodeProof(proof: RelayMemberProofInput): { bytes: Uint8Array; sig: Uint8Array } | null {
  try {
    return { bytes: decodeB64url(proof.bytes), sig: decodeB64url(proof.sig) };
  } catch {
    return null;
  }
}

/**
 * 校验一条根签名的成员记录。`admit-node` 允许 passkey 签名（中继验不了，靠令牌兜底，
 * 见 plan 1.12）；`revoke-node` 只认根签名。
 */
export function verifyRelayMemberProof(input: {
  proof: RelayMemberProofInput;
  op: 'admit' | 'revoke';
  rootPublicKey: Uint8Array;
  expectNodeId?: string;
  tolerantAdmit?: boolean;
}): RelayMemberResult {
  const decoded = decodeProof(input.proof);
  if (!decoded) return { ok: false, error: 'malformed' };
  let record: ReturnType<typeof decodeKeyLogRecord>;
  try {
    record = decodeKeyLogRecord(decoded.bytes);
  } catch {
    return { ok: false, error: 'malformed' };
  }
  const expectedType = input.op === 'admit' ? 'admit-node' : 'revoke-node';
  if (record.type !== expectedType) return { ok: false, error: 'type_mismatch' };
  if (record.signer !== 'root' && record.signer !== 'passkey') {
    return { ok: false, error: 'bad_signature' };
  }
  if (record.signer === 'passkey') {
    if (input.op === 'revoke' || input.tolerantAdmit === false) {
      return { ok: false, error: 'passkey_unverifiable' };
    }
  } else if (!verifyEd25519(decoded.sig, decoded.bytes, input.rootPublicKey)) {
    return { ok: false, error: 'bad_signature' };
  }
  return input.op === 'admit'
    ? admitResult(record, input.expectNodeId)
    : revokeResult(record, input.expectNodeId);
}

function admitResult(
  record: ReturnType<typeof decodeKeyLogRecord>,
  expectNodeId?: string
): RelayMemberResult {
  let nodeId: string;
  let edPk: Uint8Array;
  let x25519Pk: Uint8Array;
  try {
    const payload = decodeAdmitNodePayload(record.payload);
    const certificate = decodeCertificate(payload.certificate_bytes);
    nodeId = nodeIdToHex(certificate.node_id);
    edPk = certificate.ed_pk;
    x25519Pk = certificate.x25519_pk;
  } catch {
    return { ok: false, error: 'malformed' };
  }
  if (expectNodeId && expectNodeId !== nodeId) return { ok: false, error: 'node_mismatch' };
  return {
    ok: true,
    op: 'admit',
    signer: record.signer as RelayMemberSigner,
    nodeId,
    edPk,
    x25519Pk,
    seq: record.seq,
  };
}

function revokeResult(
  record: ReturnType<typeof decodeKeyLogRecord>,
  expectNodeId?: string
): RelayMemberResult {
  let nodeId: string;
  try {
    nodeId = nodeIdToHex(decodeRevokeNodePayload(record.payload).node_id);
  } catch {
    return { ok: false, error: 'malformed' };
  }
  if (expectNodeId && expectNodeId !== nodeId) return { ok: false, error: 'node_mismatch' };
  return { ok: true, op: 'revoke', signer: 'root', nodeId, seq: record.seq };
}
