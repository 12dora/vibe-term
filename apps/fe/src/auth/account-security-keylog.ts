// 账号安全动作共用的 key-log 写入与根钥签名者。

import type { AuthApi, KeyLogAppendResult } from '@vibeterm/api-client/auth/index';
import {
  type KdfParams,
  type RootKey,
  deriveSeed,
  encodeBase64url,
  rootKeyFromSeed,
} from '@vibeterm/shared/auth';
import type { RecordSigner } from './key-log-actions';
import { kdfParamsFromJson } from './key-log-actions';

export async function appendKeyLog(
  api: AuthApi,
  record: { bytes: Uint8Array; sig: Uint8Array }
): Promise<KeyLogAppendResult> {
  return api.appendKeyLog({
    bytes: encodeBase64url(record.bytes),
    sig: encodeBase64url(record.sig),
  });
}

export async function rootKeyFrom(password: string, kdfParams: KdfParams): Promise<RootKey> {
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

/** 根据密码现场造一个「根钥签名者」。调用方负责清零；能用 `withRootSigner` 就别用它。 */
export async function rootSignerFromPassword(
  password: string,
  kdfParams: { salt: string; memory_kib: number; iterations: number; parallelism: number }
): Promise<RecordSigner> {
  return { kind: 'root', rootKey: await rootKeyFrom(password, kdfParamsFromJson(kdfParams)) };
}
