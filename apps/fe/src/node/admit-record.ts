// hub 未确认的 admit 记录：暂存、重发计划与提交。
//
// 从 `enrollment.ts` 拆出来的一整块：它自成一个模块级 store（内存里的「已签好但还没被确认的
// 字节」）加上唯一的提交入口，跟证书解析 / pending 存储没有共用状态，只借用那边的失败分类。
//
// 这块的性质决定了它不能被简化：`submitAdmitRecord` **先暂存再发送**，任何「等响应回来再存」
// 的写法都会在超时 / 断网时丢掉字节，下一次轮询按新 head 重签一条，hub 就永久 `seq_gap`。

import { classifyKeyLogFailure } from './enrollment';
import { warnRelayAckGlobal } from './relay-ack';
import type { RelayAckFields } from './relay-ack';

/** 已签好、随时可以原样重发的记录（base64url）。 */
export interface SignedRecord {
  bytes: string;
  sig: string;
}

export type AdmitDisposition =
  | { kind: 'admitted' }
  | { kind: 'unconfirmed' }
  | { kind: 'stale' }
  | { kind: 'error'; code: string };

/** `POST /api/auth/keylog?hub=sync` 的响应；准入这条路径只关心这几个字段。 */
type AdmitAppend = ({ ok: true; hubAck?: boolean } & RelayAckFields) | { ok: false; code: string };

/** hub=sync 的响应 → UI 该做什么。页面与测试共用同一份判定。 */
export function admitDisposition(result: AdmitAppend): AdmitDisposition {
  if (result.ok) {
    // B2-6 之后 200 不再带 `hubAck:false`；万一遇到（旧版 entry），一律当未确认。
    return result.hubAck === true ? { kind: 'admitted' } : { kind: 'unconfirmed' };
  }
  const failure = classifyKeyLogFailure(result.code);
  if (failure === 'unconfirmed') return { kind: 'unconfirmed' };
  if (failure === 'stale') return { kind: 'stale' };
  return { kind: 'error', code: result.code };
}

/**
 * hub 未确认的 admit 记录。**只在内存里**（记录本身不含秘密，但也没有落盘的必要），
 * 放在模块级而不是组件 state：用户切走再回来仍然要能重发同一份字节。
 */
const unconfirmedRecords = new Map<string, SignedRecord>();
const unconfirmedListeners = new Set<() => void>();
let unconfirmedIds: string[] = [];

function notifyUnconfirmed(): void {
  unconfirmedIds = [...unconfirmedRecords.keys()];
  for (const listener of [...unconfirmedListeners]) {
    try {
      listener();
    } catch {
      // 同上：一个订阅者抛异常不该让「记录已暂存」这件事对其余订阅者失效。
    }
  }
}

export function subscribeUnconfirmedRecords(listener: () => void): () => void {
  unconfirmedListeners.add(listener);
  return () => {
    unconfirmedListeners.delete(listener);
  };
}

/** `useSyncExternalStore` 的快照：引用稳定，只在集合变化时换新数组。 */
export function listUnconfirmedRecordIds(): string[] {
  return unconfirmedIds;
}

export function unconfirmedRecord(pendingId: string): SignedRecord | null {
  return unconfirmedRecords.get(pendingId) ?? null;
}

/** 暂存一条已签好的记录，等待明确的处置结果。同一份字节重复暂存不再通知订阅者。 */
function rememberUnconfirmedRecord(pendingId: string, record: SignedRecord): void {
  const previous = unconfirmedRecords.get(pendingId);
  if (previous && previous.bytes === record.bytes && previous.sig === record.sig) return;
  unconfirmedRecords.set(pendingId, record);
  notifyUnconfirmed();
}

export function forgetUnconfirmedRecord(pendingId: string): void {
  if (unconfirmedRecords.delete(pendingId)) notifyUnconfirmed();
}

export function clearUnconfirmedRecords(): void {
  if (unconfirmedRecords.size === 0) return;
  unconfirmedRecords.clear();
  notifyUnconfirmed();
}

/**
 * 这条 pending 现在该做什么。
 *
 * **`resend` 永远优先于 `sign`**：只要手上还有一份 hub 未确认的记录，就原样重发它。
 * 轮询每 5 s 会重新看到同一张证书，若那时按新 head 再签一条，就会造出另一个 seq，
 * hub 缺了中间那条便永久 `seq_gap`（评审 Major 里那条不可恢复的分叉）。
 */
export function admitPlan(pendingId: string, canSign: boolean): 'resend' | 'sign' | 'wait' {
  if (unconfirmedRecords.has(pendingId)) return 'resend';
  return canSign ? 'sign' : 'wait';
}

/**
 * 送一条**已签好**的 admit 记录，并按结果决定要不要把它留着重发。
 *
 * 重试路径拿的就是这里存下的对象（`unconfirmedRecord()`），字节完全相同——重试**绝不**重新
 * 取 head、重新签名。
 *
 * **先暂存再发送**：请求抛异常（连接断开、超时、响应畸形）时，服务端到底落没落库是未知的，
 * 只有原样重发这份字节才安全；若等响应回来才暂存，异常路径下记录就丢了，下一次推送 / 轮询
 * 会按新 head 再签一条，hub 缺了中间那条便永久 `seq_gap`（见 R4 #3）。
 * 因此只有拿到**明确**的处置（已确认 / 作废 / 终态拒绝）才丢弃暂存。
 */
export async function submitAdmitRecord(
  api: { appendKeyLog(body: SignedRecord, opts?: { hubSync?: boolean }): Promise<AdmitAppend> },
  pendingId: string,
  record: SignedRecord
): Promise<AdmitDisposition> {
  rememberUnconfirmedRecord(pendingId, record);
  const appended = await api.appendKeyLog(record, { hubSync: true });
  // 准入落了本机却没上中继：新节点连不上其余成员，不能只报一句「已批准」。
  if (appended.ok) warnRelayAckGlobal(appended);
  const disposition = admitDisposition(appended);
  // 确认成功、或这条字节已经作废：都不该再留着让用户重发。
  if (disposition.kind !== 'unconfirmed') forgetUnconfirmedRecord(pendingId);
  return disposition;
}
