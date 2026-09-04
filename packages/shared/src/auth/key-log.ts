import type { WrapEntry } from '../relay/tenant-cipher';
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
  decodeRotateRootKeepPayload,
  decodeRotateRootPayload,
  decodeSetTotpPayload,
  nodeIdToHex,
  sha256,
} from './encoding';
import { applyAdmitHub, applyRetireHub, retireHubIfAdmitted } from './key-log-hub';
import type { StoredRelayList } from './relay-records';
import { MIN_RELAY_RECORD_VERSION, applyRelayKeyLogRecord, cloneRelayList } from './relay-records';
import { applyRenameNode } from './rename-node-record';
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

export type HubAuthorizationStatus = 'active' | 'retired';

export type StoredHubAuthorization = {
  status: HubAuthorizationStatus;
  publicUrl: string | null;
  priority: number | null;
  seq: bigint;
};

export type UserKeyState = {
  rootPublicKey: Uint8Array;
  rootEpoch: number;
  kdfParams: KdfParams;
  passkeys: Map<string, PasskeyRecord>;
  totp: SetTotpPayload | null;
  nodeCerts: Map<string, StoredNodeCert>;
  hubAuthorizations: Map<string, StoredHubAuthorization>;
  relays: StoredRelayList | null;
  metaKeyEpoch: number;
  metaKeyEntries: WrapEntry[];
  /** 最新 `rename-node` 投影：nodeId hex → 已 trim 的显示名。未回放密钥日志的快照可缺省。 */
  nodeNames?: Map<string, string>;
  head: KeyLogHead;
};

/** 写入 `admit-hub` / `retire-hub` 前，所有未吊销节点须达到该版本，否则旧节点无法解码新记录。 */
export const MIN_HUB_AUTH_RECORD_VERSION = '1.1.13';
/** 写入 `rotate-root-keep` 前，所有未吊销节点须达到该版本；不允许 force 绕过。 */
export const MIN_ROTATE_ROOT_KEEP_RECORD_VERSION = '1.1.16';
/** 写入 `rename-node` 前，所有未吊销节点须达到该版本；不允许 force 绕过。 */
export const MIN_RENAME_NODE_RECORD_VERSION = '1.1.24';
export const KEYLOG_TYPE_UNSUPPORTED_BY_NODES = 'KEYLOG_TYPE_UNSUPPORTED_BY_NODES';
export const HUB_AUTH_RECORD_TYPES = ['admit-hub', 'retire-hub'] as const;
export const ROTATE_ROOT_KEEP_RECORD_TYPES = ['rotate-root-keep'] as const;

export type KeyLogRecordCompatSpec = {
  minVersion: string;
  allowForce: boolean;
};

export const RELAY_RECORD_TYPES = ['set-relays', 'meta-key'] as const;
export const RENAME_NODE_RECORD_TYPES = ['rename-node'] as const;

export const KEYLOG_RECORD_COMPAT: Readonly<Partial<Record<KeyLogType, KeyLogRecordCompatSpec>>> = {
  'set-relays': { minVersion: MIN_RELAY_RECORD_VERSION, allowForce: false },
  'meta-key': { minVersion: MIN_RELAY_RECORD_VERSION, allowForce: false },
  'rename-node': { minVersion: MIN_RENAME_NODE_RECORD_VERSION, allowForce: false },
  'admit-hub': { minVersion: MIN_HUB_AUTH_RECORD_VERSION, allowForce: true },
  'retire-hub': { minVersion: MIN_HUB_AUTH_RECORD_VERSION, allowForce: true },
  'rotate-root-keep': { minVersion: MIN_ROTATE_ROOT_KEEP_RECORD_VERSION, allowForce: false },
};

export type KeyLogEffect =
  | { type: 'revokeAllSessions' }
  | { type: 'revokeSessionsByCredential'; credentialId: string }
  | { type: 'revokeSessionsVia'; nodeId: Uint8Array }
  | { type: 'clearPeerCache' };

export const KEY_LOG_SIGNER_MATRIX: Record<KeyLogType, readonly KeyLogSigner[]> = {
  'add-passkey': ['root', 'passkey'],
  'remove-passkey': ['root', 'passkey'],
  'rotate-root': ['root'],
  'set-totp': ['root', 'passkey'],
  'clear-totp': ['root', 'passkey'],
  'admit-node': ['root', 'passkey'],
  'revoke-node': ['root', 'passkey'],
  'reset-root': ['root'],
  'admit-hub': ['root', 'passkey'],
  'retire-hub': ['root', 'passkey'],
  'rotate-root-keep': ['root'],
  'set-relays': ['root', 'passkey'],
  'meta-key': ['root', 'passkey'],
  'rename-node': ['root', 'passkey'],
};

export type KeyLogSignedRecord = {
  bytes: Uint8Array;
  sig: Uint8Array;
};

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
  existingAtSeq?: KeyLogSignedRecord | Uint8Array;
  allowGenesis?: boolean;
};

export type VerifyKeyLogError =
  | 'seq_gap'
  | 'prev_hash_mismatch'
  | 'epoch_mismatch'
  | 'bad_signature'
  | 'unknown_signer'
  | 'fork'
  | 'signer_not_allowed'
  | 'reset_not_genesis';

export type VerifyKeyLogResult =
  | { ok: true; record: KeyLogRecord; hash: Uint8Array }
  | { ok: false; error: VerifyKeyLogError };

export type ApplyKeyLogError =
  | 'bad_authorization_sig'
  | 'bad_cert_sig'
  | 'enroll_pk_mismatch'
  | 'uid_mismatch'
  | 'unknown_node'
  | 'malformed_payload'
  | 'node_id_reused'
  | 'relay_epoch_regression'
  | 'totp_required';

export type ApplyKeyLogCtx = {
  verifyPasskeyAssertion?: VerifyPasskeyAssertion;
};

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
    hubAuthorizations: new Map(),
    relays: null,
    metaKeyEpoch: 0,
    metaKeyEntries: [],
    nodeNames: new Map(),
    head: genesisHead(),
  };
}

export function computeRecordHash(recordBytes: Uint8Array, sig: Uint8Array): Uint8Array {
  return sha256(concatBytes(recordBytes, sig));
}

export type IdenticalKeyLogRow = {
  seq: bigint;
  bytes: Uint8Array;
  sig: Uint8Array;
};

export async function identicalKeyLog(
  list: (seq: bigint) => Promise<readonly IdenticalKeyLogRow[]>,
  bytes: Uint8Array,
  sig: Uint8Array
): Promise<{ seq: bigint; hash: Uint8Array } | null> {
  let seq: bigint;
  try {
    seq = decodeKeyLogRecord(bytes).seq;
  } catch {
    return null;
  }
  const listed = await list(seq);
  const existing = listed.find((row) => row.seq === seq);
  if (!existing) return null;
  if (!bytesEqual(existing.bytes, bytes) || !bytesEqual(existing.sig, sig)) return null;
  return { seq, hash: computeRecordHash(existing.bytes, existing.sig) };
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

const ZERO_HASH = new Uint8Array(32);

function isZeroHash(bytes: Uint8Array): boolean {
  return bytesEqual(bytes, ZERO_HASH);
}

function incomingHash(incoming: KeyLogSignedRecord): Uint8Array {
  return computeRecordHash(incoming.bytes, incoming.sig);
}

function existingHash(existing: KeyLogSignedRecord | Uint8Array): Uint8Array {
  return existing instanceof Uint8Array
    ? existing
    : computeRecordHash(existing.bytes, existing.sig);
}

export function detectFork(existing: KeyLogSignedRecord, incoming: KeyLogSignedRecord): boolean {
  return !bytesEqual(incomingHash(existing), incomingHash(incoming));
}

function isGenesisReset(record: KeyLogRecord, ctx: VerifyKeyLogCtx): boolean {
  return (
    ctx.allowGenesis === true &&
    ctx.head.seq === 0n &&
    record.seq === 1n &&
    isZeroHash(record.prev_hash)
  );
}

export async function verifyKeyLogRecord(
  recordBytes: Uint8Array,
  sig: Uint8Array,
  ctx: VerifyKeyLogCtx
): Promise<VerifyKeyLogResult> {
  const record = decodeKeyLogRecord(recordBytes);
  if (ctx.existingAtSeq) {
    const incoming = { bytes: recordBytes, sig };
    if (!bytesEqual(existingHash(ctx.existingAtSeq), incomingHash(incoming))) {
      return { ok: false, error: 'fork' };
    }
  }
  if (record.type === 'reset-root' && !isGenesisReset(record, ctx)) {
    return { ok: false, error: 'reset_not_genesis' };
  }
  const allowed = KEY_LOG_SIGNER_MATRIX[record.type];
  if (!allowed || !allowed.includes(record.signer)) {
    return { ok: false, error: 'signer_not_allowed' };
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
    hubAuthorizations: new Map(state.hubAuthorizations),
    relays: cloneRelayList(state.relays),
    metaKeyEpoch: state.metaKeyEpoch,
    metaKeyEntries: state.metaKeyEntries.map((entry) => ({ ...entry })),
    nodeNames: new Map(state.nodeNames),
    head: { seq: state.head.seq, hash: new Uint8Array(state.head.hash) },
  };
}

export function totpPayloadFromKeyLogRecord(record: KeyLogRecord): SetTotpPayload | null {
  try {
    if (record.type === 'set-totp') {
      return decodeSetTotpPayload(record.payload);
    }
    if (record.type === 'rotate-root-keep') {
      return decodeRotateRootKeepPayload(record.payload).totp?.payload ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

function applyRootChange(
  state: UserKeyState,
  record: KeyLogRecord,
  clearNodeCerts: boolean
): ApplyKeyLogResult {
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
  const effects: KeyLogEffect[] = [{ type: 'revokeAllSessions' }];
  if (clearNodeCerts) {
    state.nodeCerts = new Map();
    state.hubAuthorizations = new Map();
    state.nodeNames = new Map();
    effects.push({ type: 'clearPeerCache' });
  }
  return { ok: true, state, effects };
}

function applyRotateRootKeep(state: UserKeyState, record: KeyLogRecord): ApplyKeyLogResult {
  let payload: ReturnType<typeof decodeRotateRootKeepPayload>;
  try {
    payload = decodeRotateRootKeepPayload(record.payload);
  } catch {
    return { ok: false, error: 'malformed_payload' };
  }
  if (payload.totp) {
    if (payload.totp.root_epoch !== record.root_epoch + 1 || payload.totp.seq !== record.seq) {
      return { ok: false, error: 'malformed_payload' };
    }
  } else if (state.totp) {
    return { ok: false, error: 'totp_required' };
  }
  state.rootPublicKey = new Uint8Array(payload.root_public_key);
  state.kdfParams = {
    salt: new Uint8Array(payload.kdf_params.salt),
    memory_kib: payload.kdf_params.memory_kib,
    iterations: payload.kdf_params.iterations,
    parallelism: payload.kdf_params.parallelism,
  };
  state.rootEpoch = state.rootEpoch + 1;
  if (payload.totp) {
    state.totp = payload.totp.payload;
  }
  return { ok: true, state, effects: [] };
}

async function applyAdmitNode(
  state: UserKeyState,
  record: KeyLogRecord,
  ctx?: ApplyKeyLogCtx
): Promise<ApplyKeyLogResult> {
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
  if (authorization.signer === 'passkey') {
    const credentialId = authorization.credential_id;
    if (!credentialId) {
      return { ok: false, error: 'bad_authorization_sig' };
    }
    const cose = state.passkeys.get(credentialId)?.public_key ?? null;
    if (!cose || !ctx?.verifyPasskeyAssertion) {
      return { ok: false, error: 'bad_authorization_sig' };
    }
    const ok = await ctx.verifyPasskeyAssertion({
      recordBytes: payload.authorization_bytes,
      sig: payload.authorization_sig,
      credentialId,
      publicKey: cose,
      challenge: sha256(payload.authorization_bytes),
    });
    if (!ok) {
      return { ok: false, error: 'bad_authorization_sig' };
    }
  } else if (authorization.signer === 'root') {
    if (
      payload.authorization_sig.length !== 64 ||
      !verifyEd25519(payload.authorization_sig, payload.authorization_bytes, state.rootPublicKey)
    ) {
      return { ok: false, error: 'bad_authorization_sig' };
    }
  } else {
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
  const hex = nodeIdToHex(stored.nodeId);
  if (state.nodeCerts.has(hex)) {
    return { ok: false, error: 'node_id_reused' };
  }
  state.nodeCerts.set(hex, stored);
  return { ok: true, state, effects: [] };
}

function applyRevokeNode(state: UserKeyState, record: KeyLogRecord): ApplyKeyLogResult {
  const payload = decodeRevokeNodePayload(record.payload);
  const hex = nodeIdToHex(payload.node_id);
  const existing = state.nodeCerts.get(hex);
  if (!existing) {
    return { ok: false, error: 'unknown_node' };
  }
  state.nodeCerts.set(hex, { ...existing, revoked: true });
  retireHubIfAdmitted(state, hex, record.seq);
  return {
    ok: true,
    state,
    effects: [{ type: 'revokeSessionsVia', nodeId: new Uint8Array(payload.node_id) }],
  };
}

type KeyLogApplier = (
  state: UserKeyState,
  record: KeyLogRecord,
  ctx?: ApplyKeyLogCtx
) => ApplyKeyLogResult | Promise<ApplyKeyLogResult>;

const KEY_LOG_APPLIERS: Record<KeyLogType, KeyLogApplier> = {
  'rotate-root': (state, record) => applyRootChange(state, record, false),
  'reset-root': (state, record) => applyRootChange(state, record, true),
  'rotate-root-keep': applyRotateRootKeep,
  'add-passkey': (state, record) => {
    const payload = decodeAddPasskeyPayload(record.payload);
    state.passkeys.set(payload.credential_id, payload);
    return { ok: true, state, effects: [] };
  },
  'remove-passkey': (state, record) => {
    const payload = decodeRemovePasskeyPayload(record.payload);
    state.passkeys.delete(payload.credential_id);
    return {
      ok: true,
      state,
      effects: [{ type: 'revokeSessionsByCredential', credentialId: payload.credential_id }],
    };
  },
  'set-totp': (state, record) => {
    state.totp = decodeSetTotpPayload(record.payload);
    return { ok: true, state, effects: [] };
  },
  'clear-totp': (state) => {
    state.totp = null;
    return { ok: true, state, effects: [] };
  },
  'admit-node': applyAdmitNode,
  'revoke-node': applyRevokeNode,
  'admit-hub': applyAdmitHub,
  'retire-hub': applyRetireHub,
  'set-relays': applyRelayKeyLogRecord,
  'meta-key': applyRelayKeyLogRecord,
  'rename-node': applyRenameNode,
};

export async function applyKeyLogRecord(
  state: UserKeyState,
  record: KeyLogRecord,
  hash: Uint8Array,
  ctx?: ApplyKeyLogCtx
): Promise<ApplyKeyLogResult> {
  const applier = KEY_LOG_APPLIERS[record.type];
  if (!applier) {
    return { ok: false, error: 'malformed_payload' };
  }
  const next = cloneState(state);
  let result: ApplyKeyLogResult;
  try {
    result = await applier(next, record, ctx);
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
 * 之后每条 `rotate-root` / `rotate-root-keep` 切换验签钥。调用方（hub join）传 `expectedRootPublicKey` = join 串中的当前根公钥，
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
  for (let i = 0; i < records.length; i++) {
    const item = records[i];
    if (!item) {
      return { ok: false, error: 'malformed_payload' };
    }
    const { bytes, sig } = item;
    let decoded: KeyLogRecord;
    try {
      decoded = decodeKeyLogRecord(bytes);
    } catch {
      return { ok: false, error: 'malformed_payload' };
    }
    if (decoded.type === 'reset-root' && i !== 0) {
      return { ok: false, error: 'reset_not_genesis' };
    }
    const verified = await verifyKeyLogRecord(bytes, sig, {
      head: state.head,
      rootEpoch: state.rootEpoch,
      rootPublicKey: state.rootPublicKey,
      resolvePasskey: (id) => state.passkeys.get(id)?.public_key ?? null,
      verifyPasskeyAssertion: options?.verifyPasskeyAssertion,
      allowGenesis: i === 0,
    });
    if (!verified.ok) {
      return verified;
    }
    const applied = await applyKeyLogRecord(state, verified.record, verified.hash, {
      verifyPasskeyAssertion: options?.verifyPasskeyAssertion,
    });
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
