// user_key_log 记录的构造与签名（纯函数，便于用共享验签器对拍）。
//
// sk_sess 不能签任何持久记录：每个动作都要么现场用密码重派生根钥，
// 要么让另一把 passkey 对该条记录做一次专用 assertion（challenge = sha256(recordBytes)）。

import type { AuthenticationResponseJSON, KeyLogHeadResponse } from '@tmex/api-client/auth/index';
import { assertForChallenge } from '@tmex/api-client/auth/index';
import type {
  AddPasskeyPayload,
  EnrollmentSigner,
  KdfParams,
  KeyLogHead,
  KeyLogSignedRecord,
  KeyLogType,
  RootKey,
  RotateRootKeepTotp,
  SetTotpPayload,
} from '@tmex/shared/auth';
import {
  buildKeyLogRecord,
  decodeBase64url,
  deriveSeed,
  encodeAddPasskeyPayload,
  encodeBase64url,
  encodeClearTotpPayload,
  encodeKeyLogRecord,
  encodePasskeyAssertion,
  encodeRemovePasskeyPayload,
  encodeRotateRootKeepPayload,
  encodeRotateRootPayload,
  encodeSetTotpPayload,
  rootKeyFromSeed,
  sha256,
  signKeyLogRecordWithRoot,
} from '@tmex/shared/auth';

export type AssertFn = (
  challenge: Uint8Array,
  credentialId: string
) => Promise<AuthenticationResponseJSON>;

/**
 * 记录签名者：根钥或另一把 passkey。
 * passkey 分支必须显式给出 `credentialId`——它要写进记录本身，
 * 而 challenge 又是 `sha256(记录字节)`，先做仪式再填 id 会导致两次用户交互。
 */
export type RecordSigner =
  | { kind: 'root'; rootKey: RootKey }
  | { kind: 'passkey'; credentialId: string; assert?: AssertFn };

const defaultAssert: AssertFn = (challenge, credentialId) =>
  assertForChallenge(challenge, { allowCredentials: [{ id: credentialId }] });

/**
 * 用一把 passkey 对任意字节串做一次专用断言，编码成 Borsh `PasskeyAssertion`。
 *
 * challenge 一律是 `sha256(待签字节)`：key-log 记录如此，enrollment 的 `Authorization`
 * 也如此（`hub-runtime.handleCreateEnrollment` / `applyAdmitNode` 都按这个算）。
 */
export async function signWithPasskey(
  signer: { credentialId: string; assert?: AssertFn },
  message: Uint8Array
): Promise<Uint8Array> {
  const assertFn = signer.assert ?? defaultAssert;
  const assertion = await assertFn(sha256(message), signer.credentialId);
  if (assertion.id !== signer.credentialId) {
    throw new Error('passkey assertion credential mismatch');
  }
  return encodePasskeyAssertion({
    credential_id: assertion.id,
    client_data_json: decodeBase64url(assertion.response.clientDataJSON),
    authenticator_data: decodeBase64url(assertion.response.authenticatorData),
    signature: decodeBase64url(assertion.response.signature),
  });
}

/**
 * `RecordSigner` → `@tmex/shared/auth` 的 `EnrollmentSigner`。
 * 根钥直接就是 `EnrollmentSigner`（有 `sign`）；passkey 侧包一层断言。
 */
export function enrollmentSignerFrom(signer: RecordSigner): EnrollmentSigner {
  if (signer.kind === 'root') return signer.rootKey;
  return {
    credentialId: signer.credentialId,
    sign: (message) => signWithPasskey(signer, message),
  };
}

export function headFromResponse(response: KeyLogHeadResponse): KeyLogHead {
  return { seq: BigInt(response.seq), hash: decodeBase64url(response.hash) };
}

export function nextSeq(head: KeyLogHead): bigint {
  return head.seq + 1n;
}

export async function deriveRootKey(password: string, kdfParams: KdfParams): Promise<RootKey> {
  const seed = await deriveSeed(password, kdfParams);
  const rootKey = rootKeyFromSeed(seed);
  seed.fill(0);
  return rootKey;
}

export function kdfParamsFromJson(json: {
  salt: string;
  memory_kib: number;
  iterations: number;
  parallelism: number;
}): KdfParams {
  return {
    salt: decodeBase64url(json.salt),
    memory_kib: json.memory_kib,
    iterations: json.iterations,
    parallelism: json.parallelism,
  };
}

/** `kdfParamsFromJson` 的逆向：把签进记录的新参数交回给 UI / 会话重建路径。 */
export function kdfParamsToJson(params: KdfParams): {
  salt: string;
  memory_kib: number;
  iterations: number;
  parallelism: number;
} {
  return {
    salt: encodeBase64url(params.salt),
    memory_kib: params.memory_kib,
    iterations: params.iterations,
    parallelism: params.parallelism,
  };
}

export interface BuildRecordInput {
  head: KeyLogHead;
  rootEpoch: number;
  uid: string;
  type: KeyLogType;
  payload: Uint8Array;
  signer: RecordSigner;
}

/** 构造并签一条记录，返回可直接 base64url 上送的 `{bytes, sig}`。 */
export async function buildSignedRecord(input: BuildRecordInput): Promise<KeyLogSignedRecord> {
  if (input.signer.kind === 'root') {
    const record = buildKeyLogRecord(input.head, input.rootEpoch, {
      uid: input.uid,
      type: input.type,
      payload: input.payload,
      signer: 'root',
      credential_id: null,
    });
    const bytes = encodeKeyLogRecord(record);
    return { bytes, sig: signKeyLogRecordWithRoot(input.signer.rootKey, bytes) };
  }

  const record = buildKeyLogRecord(input.head, input.rootEpoch, {
    uid: input.uid,
    type: input.type,
    payload: input.payload,
    signer: 'passkey',
    credential_id: input.signer.credentialId,
  });
  const bytes = encodeKeyLogRecord(record);
  return { bytes, sig: await signWithPasskey(input.signer, bytes) };
}

/**
 * 全量重置式改密：`rotate-root` 由**旧**根钥签，payload 带新根公钥与新 kdf 参数。
 * 应用后各 node 撤销全部会话、清空 passkey 与 TOTP。常规改密请用 `buildRotateRootKeepRecord`。
 */
export function buildRotateRootRecord(input: {
  head: KeyLogHead;
  rootEpoch: number;
  uid: string;
  oldRootKey: RootKey;
  newRootPublicKey: Uint8Array;
  newKdfParams: KdfParams;
}): KeyLogSignedRecord {
  const payload = encodeRotateRootPayload({
    root_public_key: new Uint8Array(input.newRootPublicKey),
    kdf_params: input.newKdfParams,
  });
  const record = buildKeyLogRecord(input.head, input.rootEpoch, {
    uid: input.uid,
    type: 'rotate-root',
    payload,
    signer: 'root',
    credential_id: null,
  });
  const bytes = encodeKeyLogRecord(record);
  return { bytes, sig: signKeyLogRecordWithRoot(input.oldRootKey, bytes) };
}

/**
 * 常规改密：`rotate-root-keep` 同样由**旧**根钥签，但应用后保留 passkey、TOTP 与全部会话。
 *
 * `totp` 是把现有 TOTP 密文按新 epoch / 新记录 seq 重新封装的结果，契约固定为
 * `root_epoch === 记录 root_epoch + 1`、`seq === 记录自身 seq`；账号没开 TOTP 时传 `null`。
 */
export function buildRotateRootKeepRecord(input: {
  head: KeyLogHead;
  rootEpoch: number;
  uid: string;
  oldRootKey: RootKey;
  newRootPublicKey: Uint8Array;
  newKdfParams: KdfParams;
  totp: RotateRootKeepTotp | null;
}): KeyLogSignedRecord {
  const payload = encodeRotateRootKeepPayload({
    root_public_key: new Uint8Array(input.newRootPublicKey),
    kdf_params: input.newKdfParams,
    totp: input.totp,
  });
  const record = buildKeyLogRecord(input.head, input.rootEpoch, {
    uid: input.uid,
    type: 'rotate-root-keep',
    payload,
    signer: 'root',
    credential_id: null,
  });
  const bytes = encodeKeyLogRecord(record);
  return { bytes, sig: signKeyLogRecordWithRoot(input.oldRootKey, bytes) };
}

export function buildAddPasskeyRecord(input: {
  head: KeyLogHead;
  rootEpoch: number;
  uid: string;
  payload: AddPasskeyPayload;
  signer: RecordSigner;
}): Promise<KeyLogSignedRecord> {
  return buildSignedRecord({
    head: input.head,
    rootEpoch: input.rootEpoch,
    uid: input.uid,
    type: 'add-passkey',
    payload: encodeAddPasskeyPayload(input.payload),
    signer: input.signer,
  });
}

export function buildRemovePasskeyRecord(input: {
  head: KeyLogHead;
  rootEpoch: number;
  uid: string;
  credentialId: string;
  signer: RecordSigner;
}): Promise<KeyLogSignedRecord> {
  return buildSignedRecord({
    head: input.head,
    rootEpoch: input.rootEpoch,
    uid: input.uid,
    type: 'remove-passkey',
    payload: encodeRemovePasskeyPayload({ credential_id: input.credentialId }),
    signer: input.signer,
  });
}

export function buildSetTotpRecord(input: {
  head: KeyLogHead;
  rootEpoch: number;
  uid: string;
  payload: SetTotpPayload;
  signer: RecordSigner;
}): Promise<KeyLogSignedRecord> {
  return buildSignedRecord({
    head: input.head,
    rootEpoch: input.rootEpoch,
    uid: input.uid,
    type: 'set-totp',
    payload: encodeSetTotpPayload(input.payload),
    signer: input.signer,
  });
}

/**
 * 中继相关的两类记录（`set-relays` / `meta-key`，plan-00 §1.4）。
 *
 * payload **不由浏览器构造**：封装 `K_log` / `K_meta` 要有全体未吊销节点的 X25519 公钥与
 * 当前世代密钥，这些只在本机节点手里，浏览器只从 `/api/mesh/relay/*` 的 prepare 端点取回
 * 已编码好的字节，包成记录后签名。签名者与其它管理动作一致：根钥或 passkey 都行。
 */
export function buildSetRelaysRecord(input: {
  head: KeyLogHead;
  rootEpoch: number;
  uid: string;
  payload: Uint8Array;
  signer: RecordSigner;
}): Promise<KeyLogSignedRecord> {
  return buildSignedRecord({ ...input, type: 'set-relays' });
}

export function buildMetaKeyRecord(input: {
  head: KeyLogHead;
  rootEpoch: number;
  uid: string;
  payload: Uint8Array;
  signer: RecordSigner;
}): Promise<KeyLogSignedRecord> {
  return buildSignedRecord({ ...input, type: 'meta-key' });
}

export function buildClearTotpRecord(input: {
  head: KeyLogHead;
  rootEpoch: number;
  uid: string;
  signer: RecordSigner;
}): Promise<KeyLogSignedRecord> {
  return buildSignedRecord({
    head: input.head,
    rootEpoch: input.rootEpoch,
    uid: input.uid,
    type: 'clear-totp',
    payload: encodeClearTotpPayload(),
    signer: input.signer,
  });
}
