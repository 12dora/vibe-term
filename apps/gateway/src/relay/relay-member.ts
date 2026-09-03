import {
  decodeAdmitNodePayload,
  decodeCertificate,
  decodeKeyLogRecord,
  decodeRevokeNodePayload,
  decodeRotateRootKeepPayload,
  decodeRotateRootPayload,
  nodeIdToHex,
  verifyEd25519,
} from '@tmex/shared/auth';
import type { RelayKeylogMemberOp } from '@tmex/shared/relay';
import { decodeB64url } from '../api/route-input';

export type RelayMemberSigner = 'root' | 'passkey';

export const ED25519_SIG_BYTES = 64;

export type RelayMemberAdmit = {
  ok: true;
  op: 'admit';
  signer: RelayMemberSigner;
  nodeId: string;
  edPk: Uint8Array;
  x25519Pk: Uint8Array;
  seq: bigint;
  rootEpoch: number;
};

export type RelayMemberRevoke = {
  ok: true;
  op: 'revoke';
  signer: 'root';
  nodeId: string;
  seq: bigint;
  rootEpoch: number;
};

/** `rotate-root` / `rotate-root-keep` / `reset-root`：旧根签名，携带新的根公钥。 */
export type RelayMemberRotateRoot = {
  ok: true;
  op: 'rotate-root';
  signer: 'root';
  newRootPublicKey: Uint8Array;
  seq: bigint;
  /** 记录自身的 epoch（= 轮换前的 epoch）；轮换后租户 epoch 变成它 +1。 */
  rootEpoch: number;
  nextRootEpoch: number;
};

export type RelayMemberError =
  | 'malformed'
  | 'type_mismatch'
  | 'bad_signature'
  | 'node_mismatch'
  /** 记录的 `root_epoch` 不是租户当前 epoch：旧世代的记录被重放。 */
  | 'epoch_mismatch'
  /** 明文记录不是本次 append 的那一条（`member.seq !== msg.seq`）。 */
  | 'seq_mismatch'
  /** passkey 签名的记录中继无法验签（验签需要 clientDataJSON），revoke / 根轮换一律忽略。 */
  | 'passkey_unverifiable';

export type RelayMemberResult =
  | RelayMemberAdmit
  | RelayMemberRevoke
  | RelayMemberRotateRoot
  | { ok: false; error: RelayMemberError };

export type RelayMemberProofInput = {
  bytes: string;
  sig: string;
};

const ROTATE_TYPES = new Set(['rotate-root', 'rotate-root-keep', 'reset-root']);

function decodeProof(proof: RelayMemberProofInput): { bytes: Uint8Array; sig: Uint8Array } | null {
  try {
    return { bytes: decodeB64url(proof.bytes), sig: decodeB64url(proof.sig) };
  } catch {
    return null;
  }
}

function typeMatches(recordType: string, op: RelayKeylogMemberOp): boolean {
  if (op === 'admit') return recordType === 'admit-node';
  if (op === 'revoke') return recordType === 'revoke-node';
  return ROTATE_TYPES.has(recordType);
}

/**
 * 校验一条附带在 `relay.keylog.append` / `relay.auth` 上的明文成员记录。
 *
 * 三条硬规则（缺一条就能重放旧记录把已吊销节点抬回 admitted）：
 * 1. `record.root_epoch` 必须等于租户**当前**根 epoch——旧世代签名一律作废；
 * 2. 随 append 上来的记录必须就是该 seq 的那一条（`expectSeq`）；
 * 3. `revoke` / `rotate-root` 只认根签名，`admit` 才允许 passkey（中继验不了，见 plan 1.12）。
 */
export function verifyRelayMemberProof(input: {
  proof: RelayMemberProofInput;
  op: RelayKeylogMemberOp;
  rootPublicKey: Uint8Array;
  rootEpoch: number;
  expectNodeId?: string;
  expectSeq?: bigint;
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
  if (!typeMatches(record.type, input.op)) return { ok: false, error: 'type_mismatch' };
  if (record.root_epoch !== input.rootEpoch) return { ok: false, error: 'epoch_mismatch' };
  if (input.expectSeq !== undefined && record.seq !== input.expectSeq) {
    return { ok: false, error: 'seq_mismatch' };
  }
  const signerError = checkSigner(record, decoded, {
    op: input.op,
    rootPublicKey: input.rootPublicKey,
    tolerantAdmit: input.tolerantAdmit,
  });
  if (signerError) return { ok: false, error: signerError };
  if (input.op === 'admit') return admitResult(record, input.expectNodeId);
  if (input.op === 'revoke') return revokeResult(record, input.expectNodeId);
  return rotateResult(record);
}

function checkSigner(
  record: ReturnType<typeof decodeKeyLogRecord>,
  decoded: { bytes: Uint8Array; sig: Uint8Array },
  input: { op: RelayKeylogMemberOp; rootPublicKey: Uint8Array; tolerantAdmit?: boolean }
): RelayMemberError | null {
  if (record.signer === 'passkey') {
    const tolerated = input.op === 'admit' && input.tolerantAdmit !== false;
    return tolerated ? null : 'passkey_unverifiable';
  }
  if (record.signer !== 'root') return 'bad_signature';
  if (decoded.sig.byteLength !== ED25519_SIG_BYTES) return 'bad_signature';
  return verifyEd25519(decoded.sig, decoded.bytes, input.rootPublicKey) ? null : 'bad_signature';
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
    rootEpoch: record.root_epoch,
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
  return {
    ok: true,
    op: 'revoke',
    signer: 'root',
    nodeId,
    seq: record.seq,
    rootEpoch: record.root_epoch,
  };
}

function rotateResult(record: ReturnType<typeof decodeKeyLogRecord>): RelayMemberResult {
  let newRootPublicKey: Uint8Array;
  try {
    newRootPublicKey =
      record.type === 'rotate-root-keep'
        ? decodeRotateRootKeepPayload(record.payload).root_public_key
        : decodeRotateRootPayload(record.payload).root_public_key;
  } catch {
    return { ok: false, error: 'malformed' };
  }
  if (newRootPublicKey.byteLength !== 32) return { ok: false, error: 'malformed' };
  return {
    ok: true,
    op: 'rotate-root',
    signer: 'root',
    newRootPublicKey,
    seq: record.seq,
    rootEpoch: record.root_epoch,
    nextRootEpoch: record.root_epoch + 1,
  };
}
