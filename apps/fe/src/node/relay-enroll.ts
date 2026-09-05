// 中继接入 / 离开 / 换元数据密钥的浏览器侧流程（plan-00 §1.9、§1.11）。
//
// 三条硬性质：
// - **enroll proof 只能由根密码签**：它是根钥对 Borsh `tmex/relay-enroll/v1` 的 Ed25519 签名，
//   passkey 断言给不出这种签名（见 plan §1.7）。因此接入对话框必须要根密码，不给 passkey 选项。
//   随后的 `set-relays` / `meta-key` 记录则与吊销同档，根密码或 passkey 都行。
// - payload 一律由本机节点算好（`/api/mesh/relay/*` 的 prepare 端点）：封装 `K_log` / `K_meta`
//   要有全体未吊销节点的 X25519 公钥，浏览器手里没有这些。
// - `取 head → 签名 → append` 整段必须在 key log 写锁里（与 admit / revoke 抢同一个头，并行会
//   造出两条同 seq 的记录）。锁由调用方注入：页面传 `withKeyLogLock`，已经在锁里的调用方
//   （引擎里紧跟 `admit-node` 的那一条）传 `alreadyLocked`。这样本模块不反向依赖引擎。

import {
  type RecordSigner,
  buildMetaKeyRecord,
  buildSetRelaysRecord,
  deriveRootKey,
  headFromResponse,
  kdfParamsFromJson,
} from '@/auth/key-log-actions';
import type { AuthApi, AuthKdfParamsJson } from '@tmex/api-client/auth/index';
import { requireRootEpoch } from '@tmex/api-client/auth/index';
import type { RelayMetaKeyOp, RelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import { relayErrorCode } from '@tmex/api-client/relay/tenant-api';
import { errorMessage } from '@tmex/shared';
import type { RootKey } from '@tmex/shared/auth';
import { bytesEqual, decodeBase64url, encodeBase64url } from '@tmex/shared/auth';
import { signRelayEnrollProof } from '@tmex/shared/relay';
import { classifyKeyLogFailure, requireRootPublicKey } from './enrollment';
import type { ReadmitResult } from './readmit-members';
import { READMIT_PENDING, readmitStaleMembers } from './readmit-members';

/** 根密码派生出的根公钥与服务端下发的不一致：密码打错了。 */
export const ROOT_PASSWORD_INVALID = 'ROOT_PASSWORD_INVALID';

/** 记录送出去了，但上级没确认（服务端未落库，可原样重来）。 */
export const RELAY_UNCONFIRMED = 'RELAY_UNCONFIRMED';

/** 已签好、可原样重发的密钥日志记录（公开数据：payload 里只有按节点封装过的密文）。 */
export interface SignedRelayRecord {
  type: 'set-relays' | 'meta-key';
  bytes: string;
  sig: string;
}

/** 一次中继流程的结论；`code` 直接用于查表（`relay.tenant.errors.*` → `auth.errors.*`）。 */
export type RelayFlowResult =
  | { ok: true }
  | {
      ok: false;
      code: string;
      /**
       * 记录已经签出来但没落账，且本地 head 没动（上级未确认 / 网络断）：同一份字节仍然接得上，
       * 调用方可以存下来稍后原样重发。`stale` / `rejected` 一律不带，重发没有意义。
       */
      record?: SignedRelayRecord;
      /** 卡在「重新确认成员」这一步：`set-relays` 一条都没签。 */
      readmit?: Pick<ReadmitResult, 'signed' | 'failed'>;
    };

/** key log 写锁的注入口（`enrollment-engine.ts` 的 `withKeyLogLock` 即是这个形状）。 */
export type KeyLogLock = <T>(run: () => Promise<T>) => Promise<T>;

/** 调用方已经持有写锁时用它——再进一次同一条 FIFO 链会直接死锁。 */
export const alreadyLocked: KeyLogLock = (run) => run();

/** 签记录所需的用户身份（`ResolvedMode` 天然满足）。 */
export interface RelayFlowMode {
  uid: string;
  rootEpoch?: number | null;
  kdfParams: AuthKdfParamsJson;
  rootPublicKey?: string | null;
}

export interface RelayFlowDeps {
  api: AuthApi;
  relayApi: RelayTenantApi;
  mode: RelayFlowMode;
  lock: KeyLogLock;
}

function failure(err: unknown): RelayFlowResult {
  const code = relayErrorCode(err);
  if (code) return { ok: false, code };
  return { ok: false, code: errorMessage(err) };
}

/**
 * 把一段待签 payload 包成密钥日志记录并提交，`取 head → 签名 → append` 全程在写锁里。
 *
 * `hub=sync`：入口先把记录送上级（中继）并等 ack，确认之前本地什么都不写。明确回 `hubAck:false`
 * 时按「未确认」上报——此时服务端一条都没落库，用户重试即可，不会造成分叉。
 */
export function appendRelayRecord(
  deps: RelayFlowDeps,
  input: { type: 'set-relays' | 'meta-key'; payload: string; signer: RecordSigner }
): Promise<RelayFlowResult> {
  return deps.lock(() => signAndSubmit(deps, input));
}

/** 锁**内**的那一段：取 head → 签名 → 提交。调用方负责持锁。 */
async function signAndSubmit(
  deps: RelayFlowDeps,
  input: { type: 'set-relays' | 'meta-key'; payload: string; signer: RecordSigner }
): Promise<RelayFlowResult> {
  try {
    const rootEpoch = requireRootEpoch(deps.mode);
    const head = headFromResponse(await deps.api.keyLogHead());
    const build = input.type === 'set-relays' ? buildSetRelaysRecord : buildMetaKeyRecord;
    const record = await build({
      head,
      rootEpoch,
      uid: deps.mode.uid,
      payload: decodeBase64url(input.payload),
      signer: input.signer,
    });
    const signed: SignedRelayRecord = {
      type: input.type,
      bytes: encodeBase64url(record.bytes),
      sig: encodeBase64url(record.sig),
    };
    return await submitSignedRecord(deps, signed);
  } catch (err) {
    return failure(err);
  }
}

/**
 * 把一份已签好的记录送上去。上级没确认（或网络断）时把字节原样带回来：本地 head 没动，
 * 重发同一份仍然接得上；重新按新 head 签一个 seq 才会把上级顶成永久 `seq_gap`。
 */
export async function submitSignedRecord(
  deps: RelayFlowDeps,
  signed: SignedRelayRecord
): Promise<RelayFlowResult> {
  try {
    const result = await deps.api.appendKeyLog(
      { bytes: signed.bytes, sig: signed.sig },
      { hubSync: true }
    );
    if (!result.ok) {
      const resendable = classifyKeyLogFailure(result.code) === 'unconfirmed';
      return { ok: false, code: result.code, ...(resendable ? { record: signed } : {}) };
    }
    if (result.hubAck === false) {
      return { ok: false, code: result.hubError || RELAY_UNCONFIRMED, record: signed };
    }
    return { ok: true };
  } catch (err) {
    // 请求根本没发出去 / 连接断了：本地 head 一样没动，字节可以重发。
    const beaten = failure(err);
    return beaten.ok ? beaten : { ...beaten, record: signed };
  }
}

/** 重发一份存下来的记录，全程在写锁里（与 admit / revoke 抢同一个头）。 */
export function resendRelayRecord(
  deps: RelayFlowDeps,
  signed: SignedRelayRecord
): Promise<RelayFlowResult> {
  return deps.lock(() => submitSignedRecord(deps, signed));
}

/**
 * 取一条 `meta-key` 的待签 payload 并提交。
 *
 * `admit`：把当前世代的 `K_meta` 补封装给刚加入的节点；`rotate`：换一个新世代并只发给剩余节点
 * （吊销之后必须紧接一条，否则被吊销的节点还能解出后续元数据）。
 */
export function appendMetaKey(
  deps: RelayFlowDeps,
  op: RelayMetaKeyOp,
  signer: RecordSigner
): Promise<RelayFlowResult> {
  // `prepare` 必须与取 head / 签名 / 提交同在一把锁里：它算的是「当前世代 + 1」，
  // 两条 admit 补发并行拿到同一个 epoch，后落账的那条必然 `relay_epoch_regression`。
  return deps.lock(async () => {
    let payload: string;
    try {
      payload = (await deps.relayApi.metaKeyPrepare(op)).payload;
    } catch (err) {
      return failure(err);
    }
    return signAndSubmit(deps, { type: 'meta-key', payload, signer });
  });
}

export interface RelayEnrollInput {
  /** 中继对外地址；接入 / 迁移 / 追加 / 重新输入口令都走这一条路径。 */
  url: string;
  /** 中继的接入口令；中继没设口令时留空。 */
  password?: string | null;
  /** 本地根密码：proof 只能由根钥签，passkey 给不出。 */
  rootPassword: string;
  /**
   * `set-relays` 落账之后、根钥清零之前的回调——刷新中继密封包**只有这一刻**手里还有根种子。
   * 抛出的异常按接入失败处理，所以调用方必须自己把失败咽掉（见 `use-relay-actions.ts`）。
   */
  afterEnroll?: (rootKey: RootKey) => Promise<void> | void;
}

/**
 * 接入中继：补签历史成员 → `proof-material` → 根钥签 proof → `enroll` → 签 `set-relays` → 提交。
 *
 * 同一条路径同时服务四件事：首次接入、hub → 中继迁移、追加第二个中继（priority 顺延）、
 * 令牌被踢后重新输入口令——差别只在节点侧算出来的 `set-relays` payload 里，浏览器这边一模一样。
 *
 * 根公钥对拍放在**发出任何请求之前**：密码打错时若照签不误，中继会拿这把假根公钥开一个新租户。
 * 根钥 seed 在 `finally` 里清零：proof、记录与 `afterEnroll`（刷新密封包）都跑完之后它没有
 * 任何后续用途。根密码只问一次：补签与 `set-relays` 共用同一把派生出来的根钥。
 */
export async function enrollRelay(
  deps: RelayFlowDeps,
  input: RelayEnrollInput
): Promise<RelayFlowResult> {
  let rootKey: Awaited<ReturnType<typeof deriveRootKey>> | null = null;
  try {
    const expected = requireRootPublicKey(deps.mode);
    rootKey = await deriveRootKey(input.rootPassword, kdfParamsFromJson(deps.mode.kdfParams));
    if (!bytesEqual(rootKey.publicKey, expected)) {
      return { ok: false, code: ROOT_PASSWORD_INVALID };
    }
    return await enrollWithRootKey(deps, input, rootKey);
  } catch (err) {
    return failure(err);
  } finally {
    rootKey?.seed.fill(0);
  }
}

/**
 * 根钥校验通过之后的三步。顺序是硬要求：远端 `enroll` 一落地就换发租户令牌并踢掉所有持旧
 * 令牌的链路（不可逆），补签放在它后面，任何一次可预期的失败（版本门禁、通行密钥、上级超时）
 * 都会留下「旧令牌已作废、`set-relays` 又没落账」的死状态。所以先在本机把 `readmit-node`
 * 全部签完——没有陈旧成员时 prepare 回空表，这一步是无操作。
 */
async function enrollWithRootKey(
  deps: RelayFlowDeps,
  input: RelayEnrollInput,
  rootKey: RootKey
): Promise<RelayFlowResult> {
  const signer: RecordSigner = { kind: 'root', rootKey };
  const readmit = await readmitStaleMembers({
    api: deps.api,
    relayApi: deps.relayApi,
    mode: deps.mode,
    lock: deps.lock,
    signer,
  });
  if (readmit.code) return readmitFailure(readmit.code, readmit.signed, readmit.failed);
  const enrolled = await enrollRemote(deps, input, rootKey);
  // 远端的 `readmitRequired` 只当事后复核：本机刚补签完还剩，说明两边看到的成员不一致，
  // 这时候切链路会把那些节点直接踢下线。
  const pending = enrolled.readmitRequired ?? 0;
  if (pending > 0) return readmitFailure(READMIT_PENDING, readmit.signed, pending);
  const result = await appendRelayRecord(deps, {
    type: 'set-relays',
    payload: enrolled.payload,
    signer,
  });
  if (result.ok) await input.afterEnroll?.(rootKey);
  return result;
}

/** 换发租户令牌那一步：拿归一化地址与时间戳，签 proof，换回 `set-relays` 的 payload。 */
async function enrollRemote(deps: RelayFlowDeps, input: RelayEnrollInput, rootKey: RootKey) {
  const material = await deps.relayApi.proofMaterial(input.url);
  const proof = signRelayEnrollProof(rootKey, { relayHost: material.relayHost, ts: material.ts });
  return await deps.relayApi.enroll({
    // 地址用节点归一化过的那个：签名绑定在它派生出的 host 上。
    url: material.url,
    password: input.password ?? null,
    proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
  });
}

function readmitFailure(code: string, signed: number, failed: number): RelayFlowResult {
  return { ok: false, code, readmit: { signed, failed } };
}

/**
 * 离开中继：一条空列表的 `set-relays`，签名者可以是根密码或 passkey（与吊销同一档）。
 */
export function leaveRelay(deps: RelayFlowDeps, signer: RecordSigner): Promise<RelayFlowResult> {
  return prepareAndSign(deps, signer, () => deps.relayApi.leavePrepare());
}

/**
 * 摘掉多中继里的某一条：其余中继原样保留，优先级由节点侧重排。
 * 只剩一条时服务端回 `RELAY_LAST`，该走 `leaveRelay()`。
 */
export function removeRelay(
  deps: RelayFlowDeps,
  url: string,
  signer: RecordSigner
): Promise<RelayFlowResult> {
  return prepareAndSign(deps, signer, () => deps.relayApi.removePrepare(url));
}

/** `prepare → 取 head → 签名 → 提交` 全程一把锁，与 `appendMetaKey` 同一条理由。 */
function prepareAndSign(
  deps: RelayFlowDeps,
  signer: RecordSigner,
  prepare: () => Promise<{ payload: string }>
): Promise<RelayFlowResult> {
  return deps.lock(async () => {
    let payload: string;
    try {
      payload = (await prepare()).payload;
    } catch (err) {
      return failure(err);
    }
    return signAndSubmit(deps, { type: 'set-relays', payload, signer });
  });
}
