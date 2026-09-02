// 账号安全动作：改密 / TOTP / passkey。
// 每个动作都要 `POST /api/auth/keylog` 追加一条由根钥或 passkey 签名的记录，
// sk_sess 一概不参与——所以每个动作都会重新要一次密码或一次 passkey 交互。

import type {
  AuthApi,
  AuthKdfParamsJson,
  KeyLogAppendResult,
  PasskeySummary,
} from '@tmex/api-client/auth/index';
import { defaultAuthApi, startRegistration } from '@tmex/api-client/auth/index';
import {
  type AddPasskeyPayload,
  type KdfParams,
  type KeyLogSignedRecord,
  type RootKey,
  type RotateRootKeepTotp,
  decodeBase64url,
  decodeSetTotpPayload,
  decryptTotpSecret,
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
  buildRotateRootKeepRecord,
  buildRotateRootRecord,
  buildSetTotpRecord,
  headFromResponse,
  kdfParamsFromJson,
  kdfParamsToJson,
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
  /**
   * 全量重置：清空所有 passkey 与 TOTP 并注销全部会话（`rotate-root`）。
   * 缺省 `false` = 常规改密（`rotate-root-keep`），登录方式与会话原样保留。
   */
  fullReset?: boolean;
  /** 账号当前是否启用 TOTP（来自 `/api/auth/mode`）：常规改密要据此重新封装密文。 */
  totpEnabled?: boolean;
  /** 根钥派生（测试注入）：拿到同一把根钥、并模拟第二次 Argon2 失败。 */
  deriveRootKey?: (password: string, kdfParams: KdfParams) => Promise<RootKey>;
}

/**
 * 把现有 TOTP 密文从旧 seed / 旧 epoch 换封到新 seed / 新 epoch。
 *
 * 解密用 `k_old = HKDF(oldSeed, epoch=E)` + AAD `{uid, E, 该 set-totp 记录的 seq}`；
 * 重加密用 `k_new = HKDF(newSeed, epoch=E+1)` + AAD `{uid, E+1, 本条 rotate 记录的 seq}`。
 * 网关没有任何一把 seed，只能校验结构与这两个元数据，真正的验证发生在下一次登录解密时。
 */
async function rewrapTotpSecret(input: {
  api: AuthApi;
  uid: string;
  oldSeed: Uint8Array;
  newSeed: Uint8Array;
  rootEpoch: number;
  recordSeq: bigint;
}): Promise<RotateRootKeepTotp | null> {
  const fetched = await input.api.getTotpRecord();
  // 只认 404 + `TOTP_NOT_ENABLED`：服务端确实说没开（`totpEnabled` 已过期）时，写
  // `totp: null` 才是对的记录。其余任何失败都只是「这次读不到」，必须中止整次改密——
  // 照写 `totp: null` 等于把用户已有的 TOTP 密文永久丢掉。
  if (!fetched.ok) {
    if (fetched.status === 404 && fetched.code === 'TOTP_NOT_ENABLED') return null;
    throw new Error(fetched.code);
  }
  const record = fetched.record;
  const nextEpoch = input.rootEpoch + 1;
  const kOld = deriveTotpKey(input.oldSeed, input.uid, input.rootEpoch);
  const kNew = deriveTotpKey(input.newSeed, input.uid, nextEpoch);
  let secret: Uint8Array | null = null;
  try {
    secret = await decryptTotpSecret(kOld, decodeSetTotpPayload(decodeBase64url(record.payload)), {
      uid: input.uid,
      root_epoch: input.rootEpoch,
      seq: BigInt(record.record_seq),
    });
    const payload = await encryptTotpSecret(kNew, secret, {
      uid: input.uid,
      root_epoch: nextEpoch,
      seq: input.recordSeq,
    });
    return { root_epoch: nextEpoch, seq: input.recordSeq, payload };
  } finally {
    secret?.fill(0);
    kOld.fill(0);
    kNew.fill(0);
  }
}

/** 本次签进记录的东西：调用方据此重建会话，不必等 `/api/auth/mode` 追上新 epoch。 */
export interface SignedPasswordChange {
  /** 记录被应用后的 root_epoch（= 签名时的 `head.rootEpoch` + 1）。 */
  nextRootEpoch: number;
  /** 写进 payload 的新 kdf 参数（salt 为 base64url）。 */
  newKdfParams: AuthKdfParamsJson;
}

export type ChangePasswordResult =
  | (Extract<KeyLogAppendResult, { ok: true }> & SignedPasswordChange)
  | Extract<KeyLogAppendResult, { ok: false }>;

function withSigned(
  result: KeyLogAppendResult,
  signed: SignedPasswordChange
): ChangePasswordResult {
  return result.ok ? { ...result, ...signed } : result;
}

/**
 * 改密：两条路径都由**旧**根钥签名，payload 都是新根公钥 + 新 kdf 参数，应用后 root_epoch += 1。
 *
 * - 常规（缺省）：`rotate-root-keep`，保留 passkey、TOTP 与全部会话；开了 TOTP 时把密文
 *   随记录一起换封（`rewrapTotpSecret`），否则新密码解不开旧密文，账号会被远程锁死。
 * - `fullReset`：`rotate-root`，清空 passkey 与 TOTP 并注销全部会话——UI 必须提前告知。
 *
 * 成功时连**签进记录的那两个值**一起返回：`/api/auth/mode` 是异步应用的，改密刚回来时
 * 很可能还给着旧 epoch 与旧 kdf 参数，拿它去重建会话必然签出一份验不过的 delegation。
 */
export async function changePassword(input: ChangePasswordInput): Promise<ChangePasswordResult> {
  const api = input.api ?? defaultAuthApi;
  const head = await api.keyLogHead();
  const derive = input.deriveRootKey ?? rootKeyFrom;
  const oldRootKey = await derive(input.oldPassword, kdfParamsFromJson(input.currentKdfParams));
  // 旧根钥从**派生成功的那一刻**起就归这个 try 管：第二次 Argon2（内存压力下会抛）失败时，
  // 旧实现的 `finally` 还没建立，旧根私钥就此留在堆里（见 F4-fix 评审 Major）。
  try {
    const newKdfParams = generateKdfParams();
    const newRootKey = await derive(input.newPassword, newKdfParams);
    try {
      const base = {
        head: headFromResponse(head),
        rootEpoch: head.rootEpoch,
        uid: input.uid,
        oldRootKey,
        newRootPublicKey: newRootKey.publicKey,
        newKdfParams,
      };
      const signed: SignedPasswordChange = {
        nextRootEpoch: head.rootEpoch + 1,
        newKdfParams: kdfParamsToJson(newKdfParams),
      };
      if (input.fullReset) {
        return withSigned(await append(api, buildRotateRootRecord(base)), signed);
      }
      const totp = input.totpEnabled
        ? await rewrapTotpSecret({
            api,
            uid: input.uid,
            oldSeed: oldRootKey.seed,
            newSeed: newRootKey.seed,
            rootEpoch: head.rootEpoch,
            recordSeq: base.head.seq + 1n,
          })
        : null;
      return withSigned(await append(api, buildRotateRootKeepRecord({ ...base, totp })), signed);
    } finally {
      newRootKey.seed.fill(0);
    }
  } finally {
    oldRootKey.seed.fill(0);
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
 * 只保留注册 origin 与当前 origin **完全一致**的 passkey。
 *
 * passkey 绑定注册时的精确 origin（scheme + host + port）：拿 node A 的凭证在 node B 发起
 * 断言，浏览器直接 `NotAllowedError`。签记录时必须从这个子集里选，不能盲取列表第一把
 * （见 F4-1 评审 Major）。
 *
 * **没有 `rp_id` 回退**：凭证注册于 `https://node.example:8443`、当前页面是
 * `https://node.example` 时，两者 rp_id 相同但 origin 不同，后端按注册 origin 验断言必然拒绝；
 * 把它标成「可用」只会给用户一个注定失败的按钮（见 F4-fix 评审 Major）。
 */
export function passkeysForOrigin(passkeys: PasskeySummary[], origin?: string): PasskeySummary[] {
  return passkeys.filter((row) => isPasskeyUsableHere(row, origin));
}

/**
 * 这把凭证能不能在**当前入口**发起断言。
 *
 * 服务端下发的 `usableHere`（B2-8：`row.origin === 本次请求的可信 origin`）优先——反代之后
 * 浏览器看到的 origin 未必是断言真正用的那个，服务端的判定才作数。旧 entry 不带该字段时，
 * 退回 origin 字符串全等（同样没有 `rp_id` 回退）。
 */
export function isPasskeyUsableHere(row: PasskeySummary, origin?: string): boolean {
  if (typeof row.usableHere === 'boolean') return row.usableHere;
  const current =
    origin ?? (globalThis as { location?: { origin?: string } }).location?.origin ?? '';
  if (!current) return true;
  return row.origin === current;
}

/** 根据密码现场造一个「根钥签名者」。调用方负责清零；能用 `withRootSigner` 就别用它。 */
export async function rootSignerFromPassword(
  password: string,
  kdfParams: { salt: string; memory_kib: number; iterations: number; parallelism: number }
): Promise<RecordSigner> {
  return { kind: 'root', rootKey: await rootKeyFrom(password, kdfParamsFromJson(kdfParams)) };
}
