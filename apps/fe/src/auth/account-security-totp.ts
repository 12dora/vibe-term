// 账号安全：两段式 TOTP 设置与清除。

import type { AuthApi, KeyLogAppendResult } from '@vibeterm/api-client/auth/index';
import { defaultAuthApi } from '@vibeterm/api-client/auth/index';
import {
  deriveSeed,
  deriveTotpKey,
  encryptTotpSecret,
  rootKeyFromSeed,
  verifyTotpCode,
} from '@vibeterm/shared/auth';
import { appendKeyLog } from './account-security-keylog';
import type { RecordSigner } from './key-log-actions';
import {
  buildClearTotpRecord,
  buildSetTotpRecord,
  headFromResponse,
  kdfParamsFromJson,
} from './key-log-actions';
import { buildOtpauthUri, generateTotpSecret } from './totp-uri';

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
 * HKDF info 是协议常量，沿用 tmex 时期的值以保持跨版本兼容。
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
    return { ok: true, result: await appendKeyLog(api, record) };
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
  return appendKeyLog(api, record);
}
