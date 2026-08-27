// 账号安全动作：改密 / TOTP / passkey。
// 每个动作都要 `POST /api/auth/keylog` 追加一条由根钥或 passkey 签名的记录，
// sk_sess 一概不参与——所以每个动作都会重新要一次密码或一次 passkey 交互。

import type { AuthApi, KeyLogAppendResult, PasskeySummary } from '@tmex/api-client/auth/index';
import { defaultAuthApi, startRegistration } from '@tmex/api-client/auth/index';
import {
  type AddPasskeyPayload,
  type KdfParams,
  type KeyLogSignedRecord,
  type RootKey,
  decodeBase64url,
  deriveSeed,
  deriveTotpKey,
  encodeBase64url,
  encryptTotpSecret,
  generateKdfParams,
  rootKeyFromSeed,
} from '@tmex/shared/auth';
import type { RecordSigner } from './key-log-actions';
import {
  buildAddPasskeyRecord,
  buildClearTotpRecord,
  buildRemovePasskeyRecord,
  buildRotateRootRecord,
  buildSetTotpRecord,
  headFromResponse,
  kdfParamsFromJson,
} from './key-log-actions';
import { buildOtpauthUri, generateTotpSecret } from './totp-uri';

export type { PasskeySummary };

async function append(api: AuthApi, record: KeyLogSignedRecord): Promise<KeyLogAppendResult> {
  return api.appendKeyLog({
    bytes: encodeBase64url(record.bytes),
    sig: encodeBase64url(record.sig),
  });
}

async function rootKeyFrom(password: string, kdfParams: KdfParams): Promise<RootKey> {
  const seed = await deriveSeed(password, kdfParams);
  const rootKey = rootKeyFromSeed(seed);
  seed.fill(0);
  return rootKey;
}

export interface ChangePasswordInput {
  api?: AuthApi;
  uid: string;
  oldPassword: string;
  newPassword: string;
  /** 当前 kdf 参数（来自 `/api/auth/mode`）。 */
  currentKdfParams: { salt: string; memory_kib: number; iterations: number; parallelism: number };
}

/**
 * 改密 = `rotate-root`，由**旧**根钥签名，payload 是新根公钥 + 新 kdf 参数。
 * 应用后 root_epoch += 1，所有 node 撤销全部会话、清空 passkey 与 TOTP——UI 必须提前告知。
 */
export async function changePassword(input: ChangePasswordInput): Promise<KeyLogAppendResult> {
  const api = input.api ?? defaultAuthApi;
  const head = await api.keyLogHead();
  const oldRootKey = await rootKeyFrom(
    input.oldPassword,
    kdfParamsFromJson(input.currentKdfParams)
  );
  const newKdfParams = generateKdfParams();
  const newRootKey = await rootKeyFrom(input.newPassword, newKdfParams);

  const record = buildRotateRootRecord({
    head: headFromResponse(head),
    rootEpoch: head.rootEpoch,
    uid: input.uid,
    oldRootKey,
    newRootPublicKey: newRootKey.publicKey,
    newKdfParams,
  });
  oldRootKey.seed.fill(0);
  newRootKey.seed.fill(0);
  return append(api, record);
}

export interface SetTotpInput {
  api?: AuthApi;
  uid: string;
  password: string;
  currentKdfParams: { salt: string; memory_kib: number; iterations: number; parallelism: number };
  /** 允许注入，便于「先展示 URI 再确认」的两段式 UI。 */
  secret?: Uint8Array;
  issuer?: string;
}

export interface SetTotpResult {
  result: KeyLogAppendResult;
  otpauthUri: string;
}

/**
 * 设置 TOTP：`k_totp = HKDF(seed, "tmex-totp"‖root_epoch, uid)`，
 * 密钥以 AES-256-GCM 加密后写进 `set-totp` payload，AAD = borsh({uid, root_epoch, seq})。
 */
export async function setTotp(input: SetTotpInput): Promise<SetTotpResult> {
  const api = input.api ?? defaultAuthApi;
  const head = await api.keyLogHead();
  const kdfParams = kdfParamsFromJson(input.currentKdfParams);
  const seed = await deriveSeed(input.password, kdfParams);
  const rootKey = rootKeyFromSeed(seed);
  const kTotp = deriveTotpKey(seed, input.uid, head.rootEpoch);
  seed.fill(0);

  const secret = input.secret ?? generateTotpSecret();
  const headValue = headFromResponse(head);
  const payload = await encryptTotpSecret(kTotp, secret, {
    uid: input.uid,
    root_epoch: head.rootEpoch,
    seq: headValue.seq + 1n,
  });
  kTotp.fill(0);

  const record = await buildSetTotpRecord({
    head: headValue,
    rootEpoch: head.rootEpoch,
    uid: input.uid,
    payload,
    signer: { kind: 'root', rootKey },
  });
  rootKey.seed.fill(0);

  const otpauthUri = buildOtpauthUri({
    secret,
    account: input.uid,
    issuer: input.issuer,
  });
  secret.fill(0);
  return { result: await append(api, record), otpauthUri };
}

export interface SignerInput {
  api?: AuthApi;
  uid: string;
  signer: RecordSigner;
}

export async function clearTotp(input: SignerInput): Promise<KeyLogAppendResult> {
  const api = input.api ?? defaultAuthApi;
  const head = await api.keyLogHead();
  const record = await buildClearTotpRecord({
    head: headFromResponse(head),
    rootEpoch: head.rootEpoch,
    uid: input.uid,
    signer: input.signer,
  });
  return append(api, record);
}

export interface RegisterPasskeyInput extends SignerInput {
  /** 用户给这把 passkey 起的名字，写进 add-passkey payload。 */
  name: string;
}

/**
 * 注册 passkey：仪式 → entry 用 @simplewebauthn/server 验证并抽出凭证字段 →
 * 前端签 `add-passkey` 记录（根钥或另一把 passkey）。
 */
export async function registerPasskey(input: RegisterPasskeyInput): Promise<KeyLogAppendResult> {
  const api = input.api ?? defaultAuthApi;
  const options = await api.passkeyRegisterOptions();
  const response = await startRegistration(options);
  const verified = await api.passkeyRegisterVerify(response, options.challenge_id);

  const payload: AddPasskeyPayload = {
    credential_id: verified.credential_id,
    public_key: decodeBase64url(verified.public_key),
    rp_id: verified.rp_id,
    origin: verified.origin,
    counter: verified.counter,
    transports: verified.transports ?? [],
    backup_eligible: verified.backup_eligible,
    backup_state: verified.backup_state,
    device_type: verified.device_type,
    name: input.name,
  };

  const head = await api.keyLogHead();
  const record = await buildAddPasskeyRecord({
    head: headFromResponse(head),
    rootEpoch: head.rootEpoch,
    uid: input.uid,
    payload,
    signer: input.signer,
  });
  return append(api, record);
}

export interface RemovePasskeyInput extends SignerInput {
  credentialId: string;
}

export async function removePasskey(input: RemovePasskeyInput): Promise<KeyLogAppendResult> {
  const api = input.api ?? defaultAuthApi;
  const head = await api.keyLogHead();
  const record = await buildRemovePasskeyRecord({
    head: headFromResponse(head),
    rootEpoch: head.rootEpoch,
    uid: input.uid,
    credentialId: input.credentialId,
    signer: input.signer,
  });
  return append(api, record);
}

/** 根据密码现场造一个「根钥签名者」。 */
export async function rootSignerFromPassword(
  password: string,
  kdfParams: { salt: string; memory_kib: number; iterations: number; parallelism: number }
): Promise<RecordSigner> {
  return { kind: 'root', rootKey: await rootKeyFrom(password, kdfParamsFromJson(kdfParams)) };
}
