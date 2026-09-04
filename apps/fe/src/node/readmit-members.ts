// 用当前根重新确认历史成员（`readmit-node`）。
//
// 改过密的账号（`rotate-root-keep`）里，`admit-node` 记录是**旧根**签的；中继只认当前根，
// 这些成员一律 `member-epoch_mismatch`，接不上。`readmit-node` 的 payload 与 `admit-node`
// 逐字段相同（证书原样不动），只是授权签名换成当前根（或授权里那把通行密钥）重新签一遍，
// 记录本身也落在当前 epoch 上。
//
// 两个硬性质：
// - **手里握着根钥就一律重新编码一份 root-signed 授权**（同 uid / enroll_pk，换成当前 epoch）：
//   当初用通行密钥授权的成员，那把密钥丢了也要能用当前密码重新确认。只有签名者是通行密钥时
//   才走断言，且必须是**授权里写着的那把**——换一把验不过（见 `applyAdmitNode`）。
// - `取 head → 签名 → append` 逐条串行，全程在 key log 写锁里；凭据交互放在锁**外**，
//   免得对话框挂着的时候把 admit / revoke 一起堵住。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { leaseSigner } from '@/auth/credential-prompt';
import { type RecordSigner, buildSignedRecord, signWithPasskey } from '@/auth/key-log-actions';
import { headFromResponse } from '@/auth/key-log-actions';
import type { AuthApi } from '@tmex/api-client/auth/index';
import { requireRootEpoch } from '@tmex/api-client/auth/index';
import type { RelayReadmitEntry, RelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import { relayErrorCode } from '@tmex/api-client/relay/tenant-api';
import type { Authorization } from '@tmex/shared/auth';
import {
  buildRootReadmitAuthorization,
  decodeAuthorization,
  decodeBase64url,
  encodeAdmitNodePayload,
  encodeBase64url,
} from '@tmex/shared/auth';

/** 用户在凭据对话框里取消。 */
export const READMIT_CANCELLED = 'READMIT_CANCELLED';

/** 本机没能列出待重新确认的成员。 */
export const READMIT_PREPARE_FAILED = 'READMIT_PREPARE_FAILED';

/** 手里这把通行密钥重签不了该条授权，只能用当前密码重新确认。 */
export const READMIT_ROOT_REQUIRED = 'READMIT_ROOT_REQUIRED';

/** 服务端给的材料解不开（授权 / 证书字节畸形）。 */
export const READMIT_MALFORMED = 'READMIT_MALFORMED';

/** 补签跑完了，中继却仍报告有陈旧成员：`set-relays` 不能提交（见 `relay-enroll.ts`）。 */
export const READMIT_PENDING = 'READMIT_PENDING';

/** 记录送出去了但上级没确认；本地 head 没动，重来一次即可。 */
const READMIT_UNCONFIRMED = 'RELAY_UNCONFIRMED';

export interface ReadmitDeps {
  api: Pick<AuthApi, 'keyLogHead' | 'appendKeyLog'>;
  relayApi: Pick<RelayTenantApi, 'readmitPrepare'>;
  mode: { uid: string; rootEpoch?: number | null };
  /** key log 写锁（`withKeyLogLock`）。 */
  lock: <T>(run: () => Promise<T>) => Promise<T>;
  /** 已经握在手里的签名者：接入流程刚用根密码派生出根钥，不必再问一次。 */
  signer?: RecordSigner | null;
  /** 没有现成签名者时问用户要一次（`purpose:'admit'`，进 5 分钟复用窗口）。 */
  prompt?: Pick<CredentialPromptHandle, 'request'>;
}

export interface ReadmitResult {
  /** 已落账的条数。 */
  signed: number;
  /** 仍旧是旧根签的条数（首条失败即停，后面的都没签）。 */
  failed: number;
  /** 失败原因；全部落账（含无事可做）时为 `null`。 */
  code: string | null;
}

class ReadmitError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ReadmitError';
  }
}

const NOTHING_TO_DO: ReadmitResult = { signed: 0, failed: 0, code: null };

/**
 * 把全部陈旧成员逐条重新确认。空列表是无操作，因此可以反复调用（接入流程与状态卡片共用）。
 */
export async function readmitStaleMembers(deps: ReadmitDeps): Promise<ReadmitResult> {
  let entries: RelayReadmitEntry[];
  try {
    entries = (await deps.relayApi.readmitPrepare()).entries;
  } catch (err) {
    return { signed: 0, failed: 0, code: relayErrorCode(err) ?? READMIT_PREPARE_FAILED };
  }
  if (entries.length === 0) return NOTHING_TO_DO;
  const signer = await resolveSigner(deps);
  if (!signer) return { signed: 0, failed: entries.length, code: READMIT_CANCELLED };
  const release = leaseSigner(signer);
  try {
    return await deps.lock(() => signEntries(deps, entries, signer));
  } finally {
    release();
  }
}

async function resolveSigner(deps: ReadmitDeps): Promise<RecordSigner | null> {
  if (deps.signer) return deps.signer;
  if (!deps.prompt) return null;
  return await deps.prompt.request({ purpose: 'admit', reuse: true });
}

/** 锁内的那一段：逐条取 head → 签名 → 提交，首条失败即停（别把后面的记录签到断掉的头上）。 */
async function signEntries(
  deps: ReadmitDeps,
  entries: RelayReadmitEntry[],
  signer: RecordSigner
): Promise<ReadmitResult> {
  let signed = 0;
  for (const entry of entries) {
    const code = await signOne(deps, entry, signer);
    if (code) return { signed, failed: entries.length - signed, code };
    signed += 1;
  }
  return { signed, failed: 0, code: null };
}

/** 一条记录的全过程；成功返回 `null`，失败返回错误码。 */
async function signOne(
  deps: ReadmitDeps,
  entry: RelayReadmitEntry,
  signer: RecordSigner
): Promise<string | null> {
  try {
    const rootEpoch = requireRootEpoch(deps.mode);
    const payload = await buildReadmitPayload(entry, signer, rootEpoch);
    const record = await buildSignedRecord({
      head: headFromResponse(await deps.api.keyLogHead()),
      rootEpoch,
      uid: deps.mode.uid,
      type: 'readmit-node',
      payload,
      signer,
    });
    const result = await deps.api.appendKeyLog(
      { bytes: encodeBase64url(record.bytes), sig: encodeBase64url(record.sig) },
      { hubSync: true }
    );
    if (!result.ok) return result.code;
    if (result.hubAck === false) return result.hubError || READMIT_UNCONFIRMED;
    return null;
  } catch (err) {
    return failureCode(err);
  }
}

interface DecodedEntry {
  authorizationBytes: Uint8Array;
  authorization: Authorization;
  certificateBytes: Uint8Array;
  certSig: Uint8Array;
}

/** 授权重签的结果：根钥换一份新编码的授权字节，通行密钥沿用原字节。 */
interface SignedAuthorization {
  authorization_bytes: Uint8Array;
  authorization_sig: Uint8Array;
}

/** payload 与 `admit-node` 同形：证书原样带回，只有授权部分是新签的。 */
async function buildReadmitPayload(
  entry: RelayReadmitEntry,
  signer: RecordSigner,
  rootEpoch: number
): Promise<Uint8Array> {
  const decoded = decodeEntry(entry);
  const authorized = await signAuthorization(decoded, signer, rootEpoch);
  return encodeAdmitNodePayload({
    authorization_bytes: authorized.authorization_bytes,
    authorization_sig: authorized.authorization_sig,
    certificate_bytes: decoded.certificateBytes,
    cert_sig: decoded.certSig,
  });
}

function decodeEntry(entry: RelayReadmitEntry): DecodedEntry {
  try {
    const authorizationBytes = decodeBase64url(entry.authorization_bytes);
    return {
      authorizationBytes,
      authorization: decodeAuthorization(authorizationBytes),
      certificateBytes: decodeBase64url(entry.certificate_bytes),
      certSig: decodeBase64url(entry.cert_sig),
    };
  } catch {
    throw new ReadmitError(READMIT_MALFORMED);
  }
}

/**
 * 根钥在手就重新编码一份 root-signed 授权（uid / enroll_pk / exp 原样，epoch 换成当前的）：
 * 原授权是哪把钥匙签的都不影响，当初用通行密钥授权、后来那把密钥丢了的成员也能救回来。
 *
 * 通行密钥只能重签**它自己签过的**那条授权：断言的 challenge 是 `sha256(授权字节)`，
 * 换一把 credential 验不过，只能改用当前密码。
 */
async function signAuthorization(
  entry: DecodedEntry,
  signer: RecordSigner,
  rootEpoch: number
): Promise<SignedAuthorization> {
  if (signer.kind === 'root') {
    return buildRootReadmitAuthorization({
      authorizationBytes: entry.authorizationBytes,
      rootEpoch,
      rootKey: signer.rootKey,
    });
  }
  const { signer: authorizedBy, credential_id: credentialId } = entry.authorization;
  if (authorizedBy !== 'passkey' || credentialId !== signer.credentialId) {
    throw new ReadmitError(READMIT_ROOT_REQUIRED);
  }
  return {
    authorization_bytes: entry.authorizationBytes,
    authorization_sig: await signWithPasskey(signer, entry.authorizationBytes),
  };
}

function failureCode(err: unknown): string {
  if (err instanceof ReadmitError) return err.code;
  return relayErrorCode(err) ?? (err instanceof Error ? err.message : String(err));
}
