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
  verifyTotpCode,
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

/**
 * 用密码现场派生根钥，交给 `fn` 用完后**在 `finally` 里清零** `RootKey.seed`。
 *
 * 直接 `await rootSignerFromPassword(...)` 再签名会把根私钥副本留在堆里直到 GC——
 * 清 TOTP、增删 passkey、admit / revoke 都是这样泄漏的（见 F4-1 评审 Major）。
 */
export async function withRootSigner<T>(
  password: string,
  kdfParams: { salt: string; memory_kib: number; iterations: number; parallelism: number },
  fn: (signer: RecordSigner) => Promise<T> | T
): Promise<T> {
  const rootKey = await rootKeyFrom(password, kdfParamsFromJson(kdfParams));
  try {
    return await fn({ kind: 'root', rootKey });
  } finally {
    rootKey.seed.fill(0);
  }
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

  try {
    const record = buildRotateRootRecord({
      head: headFromResponse(head),
      rootEpoch: head.rootEpoch,
      uid: input.uid,
      oldRootKey,
      newRootPublicKey: newRootKey.publicKey,
      newKdfParams,
    });
    return await append(api, record);
  } finally {
    oldRootKey.seed.fill(0);
    newRootKey.seed.fill(0);
  }
}

/** 两段式 TOTP 的第一段：只生成并展示密钥，**不写任何记录**。 */
export interface BeginTotpSetupInput {
  uid: string;
  issuer?: string;
  /** 允许注入（测试）。 */
  secret?: Uint8Array;
}

export interface TotpSetupDraft {
  /** 原始密钥字节。确认成功或放弃时调用方要负责清零。 */
  secret: Uint8Array;
  otpauthUri: string;
}

/**
 * 生成待确认的 TOTP 密钥。
 *
 * 先写 key-log 再展示 QR 的老流程有个致命缺口：写成功后页面刷新 / 崩溃 / 用户没来得及扫码，
 * 账号就已经要求一个用户从未保存的密钥，之后登录会被锁死（见 F4-1 评审 Major）。
 */
export function beginTotpSetup(input: BeginTotpSetupInput): TotpSetupDraft {
  const secret = input.secret ?? generateTotpSecret();
  return {
    secret,
    otpauthUri: buildOtpauthUri({ secret, account: input.uid, issuer: input.issuer }),
  };
}

export interface ConfirmTotpSetupInput {
  api?: AuthApi;
  uid: string;
  password: string;
  currentKdfParams: { salt: string; memory_kib: number; iterations: number; parallelism: number };
  /** `beginTotpSetup()` 生成的密钥。 */
  secret: Uint8Array;
  /** 用户从认证器读到的 6 位码，本地先验一遍。 */
  code: string;
  /** 秒级 UNIX 时间（测试注入）。 */
  now?: number;
}

export type ConfirmTotpSetupResult =
  | { ok: true; result: KeyLogAppendResult }
  | { ok: false; code: 'TOTP_INVALID' };

/**
 * 两段式 TOTP 的第二段：**先本地校验用户输入的验证码**，通过后才追加 `set-totp`。
 *
 * `k_totp = HKDF(seed, "tmex-totp"‖root_epoch, uid)`，密钥以 AES-256-GCM 加密后写进 payload，
 * AAD = borsh({uid, root_epoch, seq})。
 */
export async function confirmTotpSetup(
  input: ConfirmTotpSetupInput
): Promise<ConfirmTotpSetupResult> {
  const nowSec = input.now ?? Math.floor(Date.now() / 1000);
  if (!verifyTotpCode(input.secret, input.code.trim(), nowSec)) {
    return { ok: false, code: 'TOTP_INVALID' };
  }

  const api = input.api ?? defaultAuthApi;
  const head = await api.keyLogHead();
  const kdfParams = kdfParamsFromJson(input.currentKdfParams);
  const seed = await deriveSeed(input.password, kdfParams);
  const rootKey = rootKeyFromSeed(seed);
  const kTotp = deriveTotpKey(seed, input.uid, head.rootEpoch);
  seed.fill(0);

  try {
    const headValue = headFromResponse(head);
    const payload = await encryptTotpSecret(kTotp, input.secret, {
      uid: input.uid,
      root_epoch: head.rootEpoch,
      seq: headValue.seq + 1n,
    });
    const record = await buildSetTotpRecord({
      head: headValue,
      rootEpoch: head.rootEpoch,
      uid: input.uid,
      payload,
      signer: { kind: 'root', rootKey },
    });
    return { ok: true, result: await append(api, record) };
  } finally {
    kTotp.fill(0);
    rootKey.seed.fill(0);
  }
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

/**
 * 只保留注册 origin 与当前 origin 一致的 passkey。
 *
 * passkey 绑定注册时的精确 origin：拿 node A 的凭证在 node B 发起断言，浏览器直接
 * `NotAllowedError`。签记录时必须从这个子集里选，不能盲取列表第一把（见 F4-1 评审 Major）。
 */
export function passkeysForOrigin(passkeys: PasskeySummary[], origin?: string): PasskeySummary[] {
  const current =
    origin ?? (globalThis as { location?: { origin?: string } }).location?.origin ?? '';
  if (!current) return passkeys;
  const exact = passkeys.filter((row) => row.origin === current);
  if (exact.length > 0) return exact;
  // origin 对不上时退一步按 rp_id 匹配主机名（同 RP 的不同端口/子路径）。
  let host = '';
  try {
    host = new URL(current).hostname;
  } catch {
    host = '';
  }
  return host ? passkeys.filter((row) => row.rp_id === host) : [];
}

/** 根据密码现场造一个「根钥签名者」。调用方负责清零；能用 `withRootSigner` 就别用它。 */
export async function rootSignerFromPassword(
  password: string,
  kdfParams: { salt: string; memory_kib: number; iterations: number; parallelism: number }
): Promise<RecordSigner> {
  return { kind: 'root', rootKey: await rootKeyFrom(password, kdfParamsFromJson(kdfParams)) };
}
