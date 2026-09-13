// 改密：rotate-root / rotate-root-keep，以及中继模式下紧随其后的 meta-key 换代与密封包重封。

import { fetchRelayMode } from '@/node/mesh-relay';
import { relayAckError } from '@/node/relay-ack';
import {
  forgetRelayPackDebt,
  rememberPendingMetaKey,
  rememberRelayPackDebt,
} from '@/node/relay-meta-key-pending';
import { refreshRelayPack } from '@/node/relay-pack';
import type {
  AuthApi,
  AuthKdfParamsJson,
  KeyLogAppendResult,
} from '@vibeterm/api-client/auth/index';
import { defaultAuthApi } from '@vibeterm/api-client/auth/index';
import type { RelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import { defaultRelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import {
  type KdfParams,
  type KeyLogHead,
  type KeyLogSignedRecord,
  type RootKey,
  type RotateRootKeepTotp,
  computeRecordHash,
  decodeBase64url,
  decodeSetTotpPayload,
  encodeBase64url,
  generateKdfParams,
  rewrapTotpSecret as rewrapTotpCiphertext,
} from '@vibeterm/shared/auth';
import { appendKeyLog, rootKeyFrom } from './account-security-keylog';
import {
  buildMetaKeyRecord,
  buildRotateRootKeepRecord,
  buildRotateRootRecord,
  headFromResponse,
  kdfParamsFromJson,
  kdfParamsToJson,
} from './key-log-actions';

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
  /** 中继侧 API（测试注入）；缺省打本机 `/api/mesh/relay/*`。 */
  relayApi?: RelayTenantApi;
  /**
   * key log 写锁。页面传 `withKeyLogLock`（`@/node/enrollment-engine`）——`取 head → 签名 →
   * append` 与 admit / revoke 抢同一个头，且改密与紧随其后的 `meta-key` 必须连成一段。
   * 缺省不加锁（与旧行为一致，供单测直接调用）。
   */
  lock?: <T>(run: () => Promise<T>) => Promise<T>;
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
  return rewrapTotpCiphertext({
    uid: input.uid,
    oldSeed: input.oldSeed,
    newSeed: input.newSeed,
    rootEpoch: input.rootEpoch,
    totpRecordSeq: BigInt(record.record_seq),
    totp: decodeSetTotpPayload(decodeBase64url(record.payload)),
    nextSeq: input.recordSeq,
  });
}

/** 本次签进记录的东西：调用方据此重建会话，不必等 `/api/auth/mode` 追上新 epoch。 */
export interface SignedPasswordChange {
  /** 记录被应用后的 root_epoch（= 签名时的 `head.rootEpoch` + 1）。 */
  nextRootEpoch: number;
  /** 写进 payload 的新 kdf 参数（salt 为 base64url）。 */
  newKdfParams: AuthKdfParamsJson;
}

/** 改密顺带做的那条 `meta-key` 换代（非中继模式下为 `undefined`）。 */
export type MetaKeyRotationOutcome = { ok: true } | { ok: false; code: string };

export type ChangePasswordResult =
  | (Extract<KeyLogAppendResult, { ok: true }> &
      SignedPasswordChange & { metaKey?: MetaKeyRotationOutcome })
  | Extract<KeyLogAppendResult, { ok: false }>;

function withSigned(
  result: KeyLogAppendResult,
  signed: SignedPasswordChange,
  metaKey?: MetaKeyRotationOutcome
): ChangePasswordResult {
  if (!result.ok) return result;
  return { ...result, ...signed, ...(metaKey ? { metaKey } : {}) };
}

/**
 * 改密之后那一条 `meta-key`（plan §1.3：根轮换即换 `K_meta`）。
 *
 * **必须在 rotate 记录送出去之前就准备并签好**：`rotate-root`（全量重置）一落账就撤销全部会话，
 * 之后任何 `/api/mesh/relay/*` 与 `/api/auth/keylog` 都是 401，再想补这一条已经没有会话了。
 * 于是这里按「rotate 之后的头」（seq+1、prev_hash = rotate 记录的哈希）与**新** root_epoch，
 * 用**新根钥**签好待发；rotate 一 ack 就紧接着送出去，两条记录背靠背落在链上。
 */
async function prepareMetaKeyAfterRotate(input: {
  relayApi: RelayTenantApi;
  uid: string;
  rotated: KeyLogSignedRecord;
  head: KeyLogHead;
  nextRootEpoch: number;
  newRootKey: RootKey;
}): Promise<KeyLogSignedRecord | null> {
  try {
    const prepared = await input.relayApi.metaKeyPrepare({ op: 'rotate' });
    return await buildMetaKeyRecord({
      head: {
        seq: input.head.seq + 1n,
        hash: computeRecordHash(input.rotated.bytes, input.rotated.sig),
      },
      rootEpoch: input.nextRootEpoch,
      uid: input.uid,
      payload: decodeBase64url(prepared.payload),
      signer: { kind: 'root', rootKey: input.newRootKey },
    });
  } catch {
    return null;
  }
}

/** 送那条 `meta-key`；没落账就记欠账（节点页会一直挂告警并重试）。 */
async function submitMetaKeyAfterRotate(
  api: AuthApi,
  record: KeyLogSignedRecord | null
): Promise<MetaKeyRotationOutcome> {
  if (!record) {
    rememberPendingMetaKey({ id: META_KEY_AFTER_ROTATE_ID, reason: 'rotateRoot', op: ROTATE_OP });
    return { ok: false, code: 'RELAY_META_KEY_PREPARE_FAILED' };
  }
  const result = await appendKeyLog(api, record).catch(
    () => ({ ok: false, code: 'NETWORK' }) as const
  );
  // 中继没确认与 hub 没确认同一档：成员拿不到新的 `K_meta`，被吊销的节点还解得开元数据。
  // 记录已在本地生效，重发同一份字节会让入口重新尝试发布，所以照样留欠账。
  if (result.ok && result.hubAck !== false && result.relayAck !== false) return { ok: true };
  const code = result.ok
    ? (result.hubError ?? relayAckError(result) ?? 'RELAY_UNCONFIRMED')
    : result.code;
  rememberPendingMetaKey({
    id: META_KEY_AFTER_ROTATE_ID,
    reason: 'rotateRoot',
    op: ROTATE_OP,
    record: {
      type: 'meta-key',
      bytes: encodeBase64url(record.bytes),
      sig: encodeBase64url(record.sig),
    },
  });
  return { ok: false, code };
}

const META_KEY_AFTER_ROTATE_ID = 'rotate-root';
const ROTATE_OP = { op: 'rotate' } as const;

/**
 * 改密之后重封中继密封包（docs/architecture/relay.md §5b）。
 *
 * root_epoch 一变，旧密封包的 AAD 就对不上（`rotate-root` 还会被中继侧的根轮换 sidecar 直接
 * 清空），不重封则别的机器再也无法用「租户编号 + 密码」加入。
 *
 * 全量重置那一路**当场没得重封**：`rotate-root` 一落账全部会话即失效，之后每个请求都是 401。
 * 根种子绝不落存储，因此只记一笔欠账，等用户重新登录后带密码补上。
 */
async function refreshPackAfterRotate(input: {
  api: AuthApi;
  relayApi: RelayTenantApi;
  fullReset: boolean;
  newRootKey: RootKey;
  newKdfParams: KdfParams;
  nextRootEpoch: number;
}): Promise<void> {
  if (input.fullReset) {
    rememberRelayPackDebt();
    return;
  }
  const result = await refreshRelayPack({
    rootSeed: input.newRootKey.seed,
    api: input.api,
    relayApi: input.relayApi,
    kdfParams: kdfParamsToJson(input.newKdfParams),
    rootEpoch: input.nextRootEpoch,
  });
  if (result.ok) {
    forgetRelayPackDebt();
    return;
  }
  // 逐台回执里失败的那几台精确留账；请求整个没打通时哪几台不明，整份留账。
  rememberRelayPackDebt(result.transportError ? undefined : result.failed);
}

async function signPasswordRotation(input: {
  api: AuthApi;
  request: ChangePasswordInput;
  oldRootKey: RootKey;
  newRootKey: RootKey;
  newKdfParams: KdfParams;
}): Promise<{
  signed: SignedPasswordChange;
  rotated: KeyLogSignedRecord;
  head: ReturnType<typeof headFromResponse>;
}> {
  const headResponse = await input.api.keyLogHead();
  const head = headFromResponse(headResponse);
  const base = {
    head,
    rootEpoch: headResponse.rootEpoch,
    uid: input.request.uid,
    oldRootKey: input.oldRootKey,
    newRootPublicKey: input.newRootKey.publicKey,
    newKdfParams: input.newKdfParams,
  };
  const totp = input.request.fullReset
    ? undefined
    : input.request.totpEnabled
      ? await rewrapTotpSecret({
          api: input.api,
          uid: input.request.uid,
          oldSeed: input.oldRootKey.seed,
          newSeed: input.newRootKey.seed,
          rootEpoch: headResponse.rootEpoch,
          recordSeq: head.seq + 1n,
        })
      : null;
  const rotated = input.request.fullReset
    ? buildRotateRootRecord(base)
    : buildRotateRootKeepRecord({ ...base, totp: totp ?? null });
  return {
    signed: {
      nextRootEpoch: headResponse.rootEpoch + 1,
      newKdfParams: kdfParamsToJson(input.newKdfParams),
    },
    rotated,
    head,
  };
}

/** 改密这一段的锁内主体：取头 → 签 rotate → 预备 meta-key → 送 rotate → 送 meta-key。 */
async function runPasswordRotation(input: {
  api: AuthApi;
  relayApi: RelayTenantApi;
  relayMode: boolean;
  request: ChangePasswordInput;
  oldRootKey: RootKey;
  newRootKey: RootKey;
  newKdfParams: KdfParams;
}): Promise<ChangePasswordResult> {
  const { api, request } = input;
  const { signed, rotated, head } = await signPasswordRotation({
    api,
    request,
    oldRootKey: input.oldRootKey,
    newRootKey: input.newRootKey,
    newKdfParams: input.newKdfParams,
  });
  const metaKeyRecord = input.relayMode
    ? await prepareMetaKeyAfterRotate({
        relayApi: input.relayApi,
        uid: request.uid,
        rotated,
        head,
        nextRootEpoch: signed.nextRootEpoch,
        newRootKey: input.newRootKey,
      })
    : null;
  const appended = await appendKeyLog(api, rotated);
  if (!appended.ok || !input.relayMode) return withSigned(appended, signed);
  const metaKey = await submitMetaKeyAfterRotate(api, metaKeyRecord);
  await refreshPackAfterRotate({
    api,
    relayApi: input.relayApi,
    fullReset: request.fullReset === true,
    newRootKey: input.newRootKey,
    newKdfParams: input.newKdfParams,
    nextRootEpoch: signed.nextRootEpoch,
  });
  return withSigned(appended, signed, metaKey);
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
  const relayApi = input.relayApi ?? defaultRelayTenantApi;
  const derive = input.deriveRootKey ?? rootKeyFrom;
  const lock = input.lock ?? ((run) => run());
  // 「本机走不走中继」当场问网关，不看页面上那份 30 秒轮询的快照。
  const relayMode = await fetchRelayMode(relayApi);
  const oldRootKey = await derive(input.oldPassword, kdfParamsFromJson(input.currentKdfParams));
  // 旧根钥从**派生成功的那一刻**起就归这个 try 管：第二次 Argon2（内存压力下会抛）失败时，
  // 旧实现的 `finally` 还没建立，旧根私钥就此留在堆里（见 F4-fix 评审 Major）。
  try {
    const newKdfParams = generateKdfParams();
    const newRootKey = await derive(input.newPassword, newKdfParams);
    try {
      return await lock(() =>
        runPasswordRotation({
          api,
          relayApi,
          relayMode,
          request: input,
          oldRootKey,
          newRootKey,
          newKdfParams,
        })
      );
    } finally {
      newRootKey.seed.fill(0);
    }
  } finally {
    oldRootKey.seed.fill(0);
  }
}
