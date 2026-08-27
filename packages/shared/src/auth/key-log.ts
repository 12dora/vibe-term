import type {
  AddPasskeyPayload,
  KdfParams,
  KeyLogRecord,
  KeyLogSigner,
  KeyLogType,
  SetTotpPayload,
} from './encoding';
import {
  DOMAIN_KEY_LOG,
  bytesEqual,
  concatBytes,
  decodeAddPasskeyPayload,
  decodeAdmitNodePayload,
  decodeAuthorization,
  decodeCertificate,
  decodeKeyLogRecord,
  decodeRemovePasskeyPayload,
  decodeRevokeNodePayload,
  decodeRotateRootPayload,
  decodeSetTotpPayload,
  encodeKeyLogRecord,
  nodeIdToHex,
  sha256,
} from './encoding';
import type { RootKey } from './root-key';
import { verifyEd25519 } from './root-key';

export type KeyLogHead = {
  seq: bigint;
  hash: Uint8Array;
};

export type PasskeyRecord = AddPasskeyPayload;

export type StoredNodeCert = {
  nodeId: Uint8Array;
  certificateBytes: Uint8Array;
  certSig: Uint8Array;
  authorizationBytes: Uint8Array;
  authorizationSig: Uint8Array;
  revoked: boolean;
};

export type UserKeyState = {
  rootPublicKey: Uint8Array;
  rootEpoch: number;
  kdfParams: KdfParams;
  passkeys: Map<string, PasskeyRecord>;
  totp: SetTotpPayload | null;
  nodeCerts: Map<string, StoredNodeCert>;
  head: KeyLogHead;
};

export type KeyLogEffect =
  | { type: 'revokeAllSessions' }
  | { type: 'revokeSessionsByCredential'; credentialId: string }
  | { type: 'revokeSessionsVia'; nodeId: Uint8Array };

export type VerifyPasskeyAssertion = (args: {
  recordBytes: Uint8Array;
  sig: Uint8Array;
  credentialId: string;
  publicKey: Uint8Array;
  challenge: Uint8Array;
}) => boolean | Promise<boolean>;

export type VerifyKeyLogCtx = {
  head: KeyLogHead;
  rootEpoch: number;
  rootPublicKey: Uint8Array;
  resolvePasskey: (credentialId: string) => Uint8Array | null;
  verifyPasskeyAssertion?: VerifyPasskeyAssertion;
  existingAtSeq?: Uint8Array;
};

export type VerifyKeyLogError =
  | 'seq_gap'
  | 'prev_hash_mismatch'
  | 'epoch_mismatch'
  | 'bad_signature'
  | 'unknown_signer'
  | 'fork';

export type VerifyKeyLogResult =
  | { ok: true; record: KeyLogRecord; hash: Uint8Array }
  | { ok: false; error: VerifyKeyLogError };

export type ApplyKeyLogError =
  | 'bad_authorization_sig'
  | 'bad_cert_sig'
  | 'enroll_pk_mismatch'
  | 'uid_mismatch'
  | 'unknown_node'
  | 'malformed_payload';

export type ApplyKeyLogResult =
  | { ok: true; state: UserKeyState; effects: KeyLogEffect[] }
  | { ok: false; error: ApplyKeyLogError };

const DEFAULT_KDF_PARAMS: KdfParams = {
  salt: new Uint8Array(16),
  memory_kib: 65536,
  iterations: 3,
  parallelism: 1,
};

export function genesisHead(): KeyLogHead {
  return { seq: 0n, hash: new Uint8Array(32) };
}

export function emptyUserKeyState(
  rootPublicKey: Uint8Array,
  kdfParams: KdfParams = DEFAULT_KDF_PARAMS,
  rootEpoch = 0
): UserKeyState {
  return {
    rootPublicKey: new Uint8Array(rootPublicKey),
    rootEpoch,
    kdfParams: {
      salt: new Uint8Array(kdfParams.salt),
      memory_kib: kdfParams.memory_kib,
      iterations: kdfParams.iterations,
      parallelism: kdfParams.parallelism,
    },
    passkeys: new Map(),
    totp: null,
    nodeCerts: new Map(),
    head: genesisHead(),
  };
}

export function computeRecordHash(recordBytes: Uint8Array, sig: Uint8Array): Uint8Array {
  return sha256(concatBytes(recordBytes, sig));
}

export function buildKeyLogRecord(
  head: KeyLogHead,
  epoch: number,
  fields: {
    uid: string;
    type: KeyLogType;
    payload: Uint8Array;
    signer: KeyLogSigner;
    credential_id: string | null;
  }
): KeyLogRecord {
  return {
    domain: DOMAIN_KEY_LOG,
    uid: fields.uid,
    seq: head.seq + 1n,
    prev_hash: new Uint8Array(head.hash),
    root_epoch: epoch,
    type: fields.type,
    payload: new Uint8Array(fields.payload),
    signer: fields.signer,
    credential_id: fields.credential_id,
  };
}

export function signKeyLogRecordWithRoot(rootKey: RootKey, recordBytes: Uint8Array): Uint8Array {
  return rootKey.sign(recordBytes);
}

export function detectFork(
  existingRecordAtSeq: KeyLogRecord | Uint8Array,
  incomingRecord: KeyLogRecord | Uint8Array
): boolean {
  const existing =
    existingRecordAtSeq instanceof Uint8Array
      ? existingRecordAtSeq
      : encodeKeyLogRecord(existingRecordAtSeq);
  const incoming =
    incomingRecord instanceof Uint8Array ? incomingRecord : encodeKeyLogRecord(incomingRecord);
  return !bytesEqual(existing, incoming);
}

export async function verifyKeyLogRecord(
  recordBytes: Uint8Array,
  sig: Uint8Array,
  ctx: VerifyKeyLogCtx
): Promise<VerifyKeyLogResult> {
  const record = decodeKeyLogRecord(recordBytes);
  if (ctx.existingAtSeq && detectFork(ctx.existingAtSeq, recordBytes)) {
    return { ok: false, error: 'fork' };
  }
  if (record.seq !== ctx.head.seq + 1n) {
    return { ok: false, error: 'seq_gap' };
  }
  if (!bytesEqual(record.prev_hash, ctx.head.hash)) {
    return { ok: false, error: 'prev_hash_mismatch' };
  }
  if (record.root_epoch !== ctx.rootEpoch) {
    return { ok: false, error: 'epoch_mismatch' };
  }

  if (record.signer === 'root') {
    let publicKey = ctx.rootPublicKey;
    if (record.type === 'reset-root') {
      try {
        publicKey = decodeRotateRootPayload(record.payload).root_public_key;
      } catch {
        return { ok: false, error: 'bad_signature' };
      }
    }
    if (!verifyEd25519(sig, recordBytes, publicKey)) {
      return { ok: false, error: 'bad_signature' };
    }
  } else if (record.signer === 'passkey') {
    if (!record.credential_id) {
      return { ok: false, error: 'unknown_signer' };
    }
    const cose = ctx.resolvePasskey(record.credential_id);
    if (!cose || !ctx.verifyPasskeyAssertion) {
      return { ok: false, error: 'unknown_signer' };
    }
    const ok = await ctx.verifyPasskeyAssertion({
      recordBytes,
      sig,
      credentialId: record.credential_id,
      publicKey: cose,
      challenge: sha256(recordBytes),
    });
    if (!ok) {
      return { ok: false, error: 'bad_signature' };
    }
  } else {
    return { ok: false, error: 'unknown_signer' };
  }

  return { ok: true, record, hash: computeRecordHash(recordBytes, sig) };
}

function cloneState(state: UserKeyState): UserKeyState {
  return {
    rootPublicKey: new Uint8Array(state.rootPublicKey),
    rootEpoch: state.rootEpoch,
    kdfParams: {
      salt: new Uint8Array(state.kdfParams.salt),
      memory_kib: state.kdfParams.memory_kib,
      iterations: state.kdfParams.iterations,
      parallelism: state.kdfParams.parallelism,
    },
    passkeys: new Map(state.passkeys),
    totp: state.totp,
    nodeCerts: new Map(state.nodeCerts),
    head: { seq: state.head.seq, hash: new Uint8Array(state.head.hash) },
  };
}

function applyRotateOrReset(state: UserKeyState, record: KeyLogRecord): ApplyKeyLogResult {
  let payload: ReturnType<typeof decodeRotateRootPayload>;
  try {
    payload = decodeRotateRootPayload(record.payload);
  } catch {
    return { ok: false, error: 'malformed_payload' };
  }
  state.rootPublicKey = new Uint8Array(payload.root_public_key);
  state.kdfParams = {
    salt: new Uint8Array(payload.kdf_params.salt),
    memory_kib: payload.kdf_params.memory_kib,
    iterations: payload.kdf_params.iterations,
    parallelism: payload.kdf_params.parallelism,
  };
  state.rootEpoch = state.rootEpoch + 1;
  state.passkeys = new Map();
  state.totp = null;
  return { ok: true, state, effects: [{ type: 'revokeAllSessions' }] };
}

function applyAdmitNode(state: UserKeyState, record: KeyLogRecord): ApplyKeyLogResult {
  let payload: ReturnType<typeof decodeAdmitNodePayload>;
  try {
    payload = decodeAdmitNodePayload(record.payload);
  } catch {
    return { ok: false, error: 'malformed_payload' };
  }
  let authorization: ReturnType<typeof decodeAuthorization>;
  let certificate: ReturnType<typeof decodeCertificate>;
  try {
    authorization = decodeAuthorization(payload.authorization_bytes);
    certificate = decodeCertificate(payload.certificate_bytes);
  } catch {
    return { ok: false, error: 'malformed_payload' };
  }
  if (!verifyEd25519(payload.authorization_sig, payload.authorization_bytes, state.rootPublicKey)) {
    return { ok: false, error: 'bad_authorization_sig' };
  }
  if (!verifyEd25519(payload.cert_sig, payload.certificate_bytes, authorization.enroll_pk)) {
    return { ok: false, error: 'bad_cert_sig' };
  }
  if (!bytesEqual(certificate.enroll_pk, authorization.enroll_pk)) {
    return { ok: false, error: 'enroll_pk_mismatch' };
  }
  if (authorization.uid !== certificate.uid || authorization.uid !== record.uid) {
    return { ok: false, error: 'uid_mismatch' };
  }
  const stored: StoredNodeCert = {
    nodeId: new Uint8Array(certificate.node_id),
    certificateBytes: new Uint8Array(payload.certificate_bytes),
    certSig: new Uint8Array(payload.cert_sig),
    authorizationBytes: new Uint8Array(payload.authorization_bytes),
    authorizationSig: new Uint8Array(payload.authorization_sig),
    revoked: false,
  };
  state.nodeCerts.set(nodeIdToHex(stored.nodeId), stored);
  return { ok: true, state, effects: [] };
}

export function applyKeyLogRecord(
  state: UserKeyState,
  record: KeyLogRecord,
  hash: Uint8Array
): ApplyKeyLogResult {
  const next = cloneState(state);
  let result: ApplyKeyLogResult;
  try {
    switch (record.type) {
      case 'rotate-root':
      case 'reset-root':
        result = applyRotateOrReset(next, record);
        break;
      case 'add-passkey': {
        const payload = decodeAddPasskeyPayload(record.payload);
        next.passkeys.set(payload.credential_id, payload);
        result = { ok: true, state: next, effects: [] };
        break;
      }
      case 'remove-passkey': {
        const payload = decodeRemovePasskeyPayload(record.payload);
        next.passkeys.delete(payload.credential_id);
        result = {
          ok: true,
          state: next,
          effects: [{ type: 'revokeSessionsByCredential', credentialId: payload.credential_id }],
        };
        break;
      }
      case 'set-totp':
        next.totp = decodeSetTotpPayload(record.payload);
        result = { ok: true, state: next, effects: [] };
        break;
      case 'clear-totp':
        next.totp = null;
        result = { ok: true, state: next, effects: [] };
        break;
      case 'admit-node':
        result = applyAdmitNode(next, record);
        break;
      case 'revoke-node': {
        const payload = decodeRevokeNodePayload(record.payload);
        const hex = nodeIdToHex(payload.node_id);
        const existing = next.nodeCerts.get(hex);
        if (!existing) {
          return { ok: false, error: 'unknown_node' };
        }
        next.nodeCerts.set(hex, { ...existing, revoked: true });
        result = {
          ok: true,
          state: next,
          effects: [{ type: 'revokeSessionsVia', nodeId: new Uint8Array(payload.node_id) }],
        };
        break;
      }
      default:
        return { ok: false, error: 'malformed_payload' };
    }
  } catch {
    return { ok: false, error: 'malformed_payload' };
  }
  if (!result.ok) {
    return result;
  }
  result.state.head = { seq: record.seq, hash: new Uint8Array(hash) };
  return result;
}

export type VerifyKeyLogChainError =
  | VerifyKeyLogError
  | ApplyKeyLogError
  | 'head_hash_mismatch'
  | 'missing_genesis'
  | 'root_mismatch';

export type VerifyKeyLogChainResult =
  | { ok: true; state: UserKeyState }
  | { ok: false; error: VerifyKeyLogChainError };

/**
 * 链是自描述的：首条记录必须是自签的 `reset-root`（genesis），其 payload 给出 epoch-0 根公钥；
 * 之后每条 `rotate-root` 切换验签钥。调用方（hub join）传 `expectedRootPublicKey` = join 串中的当前根公钥，
 * 回放到头后必须与 `state.rootPublicKey` 一致。
 */
export async function verifyKeyLogChain(
  records: { bytes: Uint8Array; sig: Uint8Array }[],
  expectedRootPublicKey: Uint8Array | null,
  expectedHeadHash?: Uint8Array,
  options?: {
    verifyPasskeyAssertion?: VerifyPasskeyAssertion;
  }
): Promise<VerifyKeyLogChainResult> {
  const first = records[0];
  if (!first) {
    return { ok: false, error: 'missing_genesis' };
  }
  let genesis: KeyLogRecord;
  try {
    genesis = decodeKeyLogRecord(first.bytes);
  } catch {
    return { ok: false, error: 'missing_genesis' };
  }
  if (genesis.type !== 'reset-root' || genesis.seq !== 1n) {
    return { ok: false, error: 'missing_genesis' };
  }
  let state = emptyUserKeyState(new Uint8Array(32), undefined, genesis.root_epoch);
  for (const { bytes, sig } of records) {
    const verified = await verifyKeyLogRecord(bytes, sig, {
      head: state.head,
      rootEpoch: state.rootEpoch,
      rootPublicKey: state.rootPublicKey,
      resolvePasskey: (id) => state.passkeys.get(id)?.public_key ?? null,
      verifyPasskeyAssertion: options?.verifyPasskeyAssertion,
    });
    if (!verified.ok) {
      return verified;
    }
    const applied = applyKeyLogRecord(state, verified.record, verified.hash);
    if (!applied.ok) {
      return applied;
    }
    state = applied.state;
  }
  if (expectedHeadHash && !bytesEqual(state.head.hash, expectedHeadHash)) {
    return { ok: false, error: 'head_hash_mismatch' };
  }
  if (expectedRootPublicKey && !bytesEqual(state.rootPublicKey, expectedRootPublicKey)) {
    return { ok: false, error: 'root_mismatch' };
  }
  return { ok: true, state };
}
